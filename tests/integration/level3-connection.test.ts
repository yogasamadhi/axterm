import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebServer from '../../packages/infra/web-server/src/index.ts';
import * as Connection from '../../packages/infra/connection/src/index.ts';
import {
  credentialKey,
  type CredentialRecord,
} from '../../packages/infra/credentials/src/index.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';

const contexts: Context[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  port = 0,
  record?: CredentialRecord,
  config: Connection.ConnectionConfig = {},
) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(MemoryCredentials);
  if (record)
    await ctx.credentials.modifyRecord(
      credentialKey('client-connection', 'browser-session'),
      async () => record,
    );
  await ctx.plugin(WebServer, { host: '127.0.0.1', port });
  const connection = await ctx.plugin(Connection, config);
  const root = await mkdtemp(join(tmpdir(), 'axterm-connect-'));
  directories.push(root);
  const file = await ctx.connection.createLaunchTokenFile(root);
  const token = await readFile(file, 'utf8');
  const origin = ctx.webServer.getOrigin();
  ctx.connection.fetch.register({
    path: '/api/probe',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response('admitted'),
  });
  return { ctx, connection, file, token, origin };
}
async function authenticate(
  f: Awaited<ReturnType<typeof fixture>>,
  input: unknown = { token: f.token },
) {
  return fetch(f.origin + '/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

describe('generation-bound POST connection authentication', () => {
  it('delivers a private credential file, exchanges only POST JSON and never embeds authentication in URLs', async () => {
    const f = await fixture();
    if (process.platform !== 'win32') {
      expect((await stat(f.file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(f.file, '..'))).mode & 0o777).toBe(0o700);
    }
    expect(f.ctx.connection.authenticatedUrl(f.origin + '/')).toBe(f.origin + '/');
    expect(() => f.ctx.connection.authenticatedUrl(f.origin + '/?token=forbidden')).toThrow(
      'forbidden',
    );
    expect((await fetch(f.origin + '/connect?token=forbidden')).status).toBe(405);
    expect((await fetch(f.origin + '/api/probe')).status).toBe(401);
    const response = await authenticate(f);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    expect(cookie.includes(f.token)).toBe(false);
    expect(await response.text()).toBe('{"ok":true}');
    expect(
      await (
        await fetch(f.origin + '/api/probe', { headers: { cookie: cookie.split(';')[0]! } })
      ).text(),
    ).toBe('admitted');
    await f.ctx.fiber.dispose();
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('revokes all prior Web/API cookies on logout and preserves the revocation through Connection reload', async () => {
    const f = await fixture();
    const login = await authenticate(f),
      cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const apiLogin = await authenticate(f, { token: f.token, kind: 'api' });
    const apiCookie = apiLogin.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie: apiCookie } })).status).toBe(
      200,
    );
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie } })).status).toBe(200);
    const forbidden = await fetch(f.origin + '/connect', {
      method: 'DELETE',
      headers: { cookie, origin: 'https://untrusted.invalid' },
    });
    expect(forbidden.status).toBe(403);
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie } })).status).toBe(200);
    const logout = await fetch(f.origin + '/connect', {
      method: 'DELETE',
      headers: { cookie, origin: f.origin },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie } })).status).toBe(401);
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie: apiCookie } })).status).toBe(
      401,
    );
    await f.connection.dispose();
    await f.ctx.plugin(Connection);
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie } })).status).toBe(401);
    const next = await authenticate(f);
    expect(next.status).toBe(200);
    const refreshed = next.headers.get('set-cookie')!.split(';')[0]!;
    f.ctx.connection.fetch.register({
      path: '/api/probe',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response('admitted'),
    });
    expect((await fetch(f.origin + '/api/probe', { headers: { cookie: refreshed } })).status).toBe(
      200,
    );
  });
  it('rejects malformed, oversized, wrong-token and cross-origin exchanges before admitting work', async () => {
    const f = await fixture();
    expect((await authenticate(f, { token: 'incorrect' })).status).toBe(401);
    expect((await authenticate(f, { token: f.token, unexpected: true })).status).toBe(400);
    expect(
      (
        await fetch(f.origin + '/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{invalid',
        })
      ).status,
    ).toBe(400);
    expect((await fetch(f.origin + '/connect', { method: 'POST', body: 'untyped' })).status).toBe(
      415,
    );
    const blocked = await fetch(f.origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: JSON.stringify({ token: f.token }),
    });
    expect(blocked.status).toBe(403);
    expect(
      (
        await fetch(f.origin + '/connect?token=forbidden', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: f.token }),
        })
      ).status,
    ).toBe(400);
    const oversized = await authenticate(f, { token: 'x'.repeat(5000) });
    expect(oversized.status).toBe(413);
  });
  it('rejects a former generation cookie even when authority and saved signing key are unchanged', async () => {
    const first = await fixture();
    const port = first.ctx.webServer.port!;
    const key = await first.ctx.credentials.readRecord(
      credentialKey('client-connection', 'browser-session'),
    );
    const cookie = (await authenticate(first)).headers.get('set-cookie')!.split(';')[0]!;
    await first.ctx.fiber.dispose();
    const next = await fixture(port, key);
    expect(next.origin).toBe(first.origin);
    expect((await fetch(next.origin + '/api/probe', { headers: { cookie } })).status).toBe(401);
    expect((await authenticate(next, { token: first.token })).status).toBe(401);
    expect((await authenticate(next)).status).toBe(200);
  });
  it('bounds unfinished exchanges before body consumption and applies a body deadline', async () => {
    const f = await fixture(0, undefined, { maxPendingConnects: 1 });
    const pending = httpRequest(f.origin + '/connect', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '100',
        expect: '100-continue',
      },
    });
    pending.on('error', () => {});
    const continued = once(pending, 'continue');
    pending.flushHeaders();
    try {
      await continued;
      expect((await authenticate(f)).status).toBe(429);
    } finally {
      pending.destroy();
    }
    const timed = await fixture(0, undefined, { connectBodyTimeoutMs: 40 });
    const slow = httpRequest(timed.origin + '/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '100' },
    });
    slow.on('error', () => {});
    const response = once(slow, 'response');
    slow.flushHeaders();
    try {
      const [received] = await response;
      expect(received.statusCode).toBe(408);
      received.resume();
    } finally {
      slow.destroy();
    }
  });

  it('bounds API peer admission and reclaims the contribution when the operator releases it', async () => {
    const f = await fixture(0, undefined, { maxApiPeers: 1 });
    const first = await authenticate(f, { token: f.token, kind: 'api' });
    expect(first.status).toBe(200);
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    expect((await authenticate(f, { token: f.token, kind: 'api' })).status).toBe(429);
    const admission = f.ctx.connection.admitConnection({
      headers: { host: new URL(f.origin).host, cookie },
    });
    if ('rejection' in admission) throw new Error('API peer was not admitted');
    await admission.release();
    expect(admission.peer.signal.aborted).toBe(true);
    expect((await authenticate(f, { token: f.token, kind: 'api' })).status).toBe(200);
  });

  it('ends a streaming response and its request signal when its peer owner unloads', async () => {
    const f = await fixture();
    const cancelled = Promise.withResolvers<void>();
    f.ctx.connection.fetch.register({
      path: '/api/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('ready'));
              request.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
            },
            cancel() {
              cancelled.resolve();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const cookie = (await authenticate(f)).headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(f.origin + '/api/events', { headers: { cookie } });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await f.connection.dispose();
    await cancelled.promise;
    expect((await fetch(f.origin + '/api/probe')).status).toBe(404);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  });
});

it('flushes an authenticated early receipt before closing an unread large streaming request', async () => {
  const f = await fixture();
  const cookie = (await authenticate(f)).headers.get('set-cookie')!.split(';')[0]!;
  f.ctx.connection.fetch.register({
    path: '/api/early-receipt',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async () => Response.json({ id: 'existing-receipt' }),
  });
  const result = await fetch(f.origin + '/api/early-receipt', {
    method: 'POST',
    headers: { cookie },
    body: Buffer.alloc(8 * 1024 * 1024),
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ id: 'existing-receipt' });
});

it('bounds unread-body draining and releases a streaming request that never sends EOF', async () => {
  const f = await fixture();
  const cookie = (await authenticate(f)).headers.get('set-cookie')!.split(';')[0]!;
  f.ctx.connection.fetch.register({
    path: '/api/early-stalled',
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: async () => Response.json({ id: 'stalled-receipt' }),
  });
  const request = httpRequest(f.origin + '/api/early-stalled', {
    method: 'POST',
    headers: { cookie, 'transfer-encoding': 'chunked' },
  });
  request.on('error', () => {});
  const response = once(request, 'response');
  request.write('one partial chunk');
  try {
    const [incoming] = (await response) as [IncomingMessage];
    expect(incoming.statusCode).toBe(200);
    let body = '';
    for await (const chunk of incoming) body += chunk.toString();
    expect(JSON.parse(body)).toEqual({ id: 'stalled-receipt' });
  } finally {
    request.destroy();
  }
});

it('bounds Web authentication attempts without per-client state and preserves the window across provider reload', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  try {
    const f = await fixture();
    for (let index = 0; index < 20; index++)
      expect((await authenticate(f, { token: 'invalid-token' })).status).toBe(401);
    const limited = await authenticate(f);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    await f.connection.dispose();
    await f.ctx.plugin(Connection);
    expect((await authenticate(f)).status).toBe(429);
    clock.mockReturnValue(1_700_000_060_000);
    expect((await authenticate(f)).status).toBe(200);
    const other = await fixture();
    expect((await authenticate(other)).status).toBe(200);
  } finally {
    clock.mockRestore();
  }
});
