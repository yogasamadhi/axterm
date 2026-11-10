import type { ConnectionHandle } from '../../packages/infra/connection/src/client/index.ts';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import desktopRemote from '../../packages/plugins/desktop/lib/typert.remote-client.js';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [],
  homes: string[] = [],
  releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const f of profiles.splice(0).reverse()) await f.close();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-retained-rpc-'));
  homes.push(home);
  const f = await remoteProfile(home, { application: true });
  profiles.push(f);
  const off = await f.client.remote.$mount(desktopRemote);
  f.client.effect(() => off);
  const connection = f.client.get('connection') as unknown as ConnectionHandle;
  await vi.waitFor(() => expect(connection.generation.getSnapshot()).toBeDefined());
  return { ...f, connection };
}
function generationListeners(connection: ConnectionHandle) {
  const original = connection.generation.subscribe.bind(connection.generation),
    live = new Set<symbol>();
  vi.spyOn(connection.generation, 'subscribe').mockImplementation((listener) => {
    const token = Symbol(),
      release = original(listener);
    live.add(token);
    return () => {
      expect(live.delete(token)).toBe(true);
      release();
    };
  });
  return live;
}
it('cancels caller-owned real Remote diagnostics without retiring the authenticated connection or exchanging credentials again', async () => {
  const original = globalThis.fetch.bind(globalThis);
  let connects = 0,
    delay = false,
    signal: AbortSignal | null | undefined;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  releases.push(() => release.resolve());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === '/connect') connects++;
    const response = await original(input, init);
    if (delay && path === '/api/desktop/getDiagnostics') {
      signal = init?.signal;
      const buffered = new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
      entered.resolve();
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        void release.promise.then(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        });
        if (signal?.aborted) abort();
      });
      return buffered;
    }
    return response;
  });
  const f = await fixture(),
    connection = f.connection.generation.getSnapshot(),
    first = await remoteValue(f.client.remote.desktop.getRuntimeMetadata());
  const listeners = generationListeners(f.connection);
  const owner = new AbortController();
  delay = true;
  const pending = remoteValue(f.client.remote.desktop.getDiagnostics(owner.signal));
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' });
  await entered.promise;
  expect(listeners.size).toBe(1);
  owner.abort();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(f.connection.generation.getSnapshot()).toBe(connection);
  delay = false;
  const diagnostics = await remoteValue(f.client.remote.desktop.getDiagnostics());
  expect(diagnostics.generation).toBe(first.generation);
  expect(connects).toBe(1);
  expect(listeners.size).toBe(0);
});
it('discards a real earlier-generation Remote response even when its buffered transport ignores abort', async () => {
  const original = globalThis.fetch.bind(globalThis);
  let delay = false,
    signal: AbortSignal | null | undefined;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  releases.push(() => release.resolve());
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (
      delay &&
      new URL(input instanceof Request ? input.url : String(input)).pathname ===
        '/api/desktop/getRuntimeMetadata'
    ) {
      signal = init?.signal;
      const buffered = new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
      entered.resolve();
      await release.promise;
      return buffered;
    }
    return response;
  });
  const f = await fixture();
  await remoteValue(f.client.remote.desktop.getRuntimeMetadata());
  const generation = f.connection.generation.getSnapshot()!;
  const listeners = generationListeners(f.connection);
  delay = true;
  const pending = remoteValue(f.client.remote.desktop.getRuntimeMetadata());
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' });
  await entered.promise;
  f.connection.reconnect();
  expect(f.connection.generation.getSnapshot()).not.toBe(generation);
  release.resolve();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(listeners.size).toBe(0);
});

it('retains original malformed and oversized authentication inputs without echoing values or adding a missing-route fallback', async () => {
  const f = await fixture(),
    token = (await readFile(f.application.ctx.webStartup.tokenFile!, 'utf8')).trim(),
    origin = new URL(f.application.ctx.webStartup.url).origin;
  for (const body of [
    '{',
    '{}',
    JSON.stringify({ token: 3 }),
    JSON.stringify({ token, extra: 'REMOTE_INPUT_CANARY' }),
  ]) {
    const response = await fetch(origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('REMOTE_INPUT_CANARY');
    expect(text).not.toContain(token);
  }
  expect(
    (
      await fetch(origin + '/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'x'.repeat(5000) }),
      })
    ).status,
  ).toBe(413);
  expect((await f.request('/missing', { method: 'GET' })).status).toBe(404);
});

it('retains exact hostile Origin and Host refusal and closes the obsolete cross-origin preflight surface', async () => {
  const f = await fixture(),
    origin = new URL(f.application.ctx.webStartup.url).origin;
  for (const hostile of ['null', 'https://evil.example', 'http://127.0.0.1:5174']) {
    const response = await f.request('/api/desktop/getRuntimeMetadata', {
      method: 'POST',
      headers: { origin: hostile, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
  // Node Fetch rewrites Host from its URL; use an actual wire header for the rebinding probe.
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      origin + '/api/desktop/getRuntimeMetadata',
      { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end('{}');
  });
  expect(hostileHostStatus).toBe(403);
  const preflight = await f.request('/api/desktop/getRuntimeMetadata', {
    method: 'OPTIONS',
    headers: { origin },
  });
  expect(preflight.status).toBe(404);
  expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
});
