import * as Sqlite from '@axterm/infra-storage-sqlite';
import { randomUUID } from 'node:crypto';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { REMOTE_STREAM_MUX_PATH } from '@axterm/plugin-api/stream-protocol';
import WebServer from '@axterm/infra-web-server';
import Registry from '@axterm/infra-typert-registry';
import * as Connection from '@axterm/infra-connection';
import {
  DesktopAuthentication,
  createDesktopAuthentication,
  DESKTOP_AUTH_HEADER,
} from '@axterm/infra-connection';
import Gateway from '../../packages/infra/gateway/src/index.ts';
import Access from '../../packages/infra/remote-access/src/index.ts';
import Desktop from '../../packages/plugins/desktop/src/index.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { validateTypertManifest } from '../../packages/infra/typert-loader/src/index.ts';
import {
  installConnection,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import * as DesktopClient from '../../packages/plugins/desktop/src/client/index.ts';

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
function context() {
  const ctx = new Context();
  contexts.push(ctx);
  return ctx;
}
function identity(mode: 'desktop' | 'web', generation: string = randomUUID()) {
  return Object.freeze({
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode,
    appVersion: '0.10.0',
  });
}
async function fixture() {
  const host = context();
  const auth = createDesktopAuthentication();
  host.provide('runtimeIdentity', identity('desktop', auth.verifier.generation));
  host.provide('desktopAuthenticationVerifier', auth.verifier);
  await host.plugin(MemoryCredentials);
  await host.plugin(Storage);
  await host.plugin(Schema);
  await host.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await host.plugin(Sqlite, { path: ':memory:' });
  await host.plugin(Domains, { backend: 'relational', routes: { desktop_diagnostics: 'sqlite' } });
  const writes = vi.spyOn(host.credentials, 'modifyRecord');
  await host.plugin(Registry);
  await host.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const connection = host.plugin(Connection);
  await connection;
  await host.plugin(Access);
  await host.plugin(Gateway);
  await host.plugin(Desktop);
  const artifact = await import('../../packages/plugins/desktop/lib/typert.host.js');
  host.typert.register(validateTypertManifest('@axterm/plugin-desktop', artifact.TYPERT));
  host.connection.fetch.register({
    path: '/api/probe',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => new Response('admitted'),
  });
  return { host, auth, connection, writes, origin: host.webServer.getOrigin() };
}
it('keeps only a generation-bound verifier in Host configuration and authenticates canonical header values', () => {
  const auth = createDesktopAuthentication();
  expect(auth.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(auth.verifier)).not.toContain(auth.credential);
  const verifier = new DesktopAuthentication(auth.verifier, auth.verifier.generation);
  const request = { url: '/', headers: { [DESKTOP_AUTH_HEADER]: auth.credential } };
  expect(verifier.isAuthenticated(request)).toBe(true);
  for (const value of [
    undefined,
    '',
    auth.credential + '=',
    auth.credential + ' ',
    'x'.repeat(43),
    [auth.credential, auth.credential],
  ])
    expect(verifier.isAuthenticated({ headers: { [DESKTOP_AUTH_HEADER]: value } })).toBe(false);
  expect(verifier.isAuthenticated({ url: '/?token=forbidden', headers: request.headers })).toBe(
    false,
  );
  expect(verifier.isAuthenticated({ headers: { cookie: 'untrusted-cookie' } })).toBe(false);
  expect(verifier.authenticateApi(request)).toBeUndefined();
  const nextGeneration = randomUUID();
  const rotated = new DesktopAuthentication(
    { ...auth.verifier, generation: nextGeneration },
    nextGeneration,
  );
  expect(rotated.isAuthenticated(request)).toBe(false);
  rotated.dispose();
  verifier.dispose();
  expect(verifier.isAuthenticated(request)).toBe(false);
  expect(() => new DesktopAuthentication(auth.verifier, randomUUID())).toThrow(
    'DESKTOP_AUTH_INVALID_VERIFIER',
  );
  expect(
    () =>
      new DesktopAuthentication(
        { ...auth.verifier, digest: 'private-invalid-input' },
        auth.verifier.generation,
      ),
  ).toThrow('DESKTOP_AUTH_INVALID_VERIFIER');
});
it('requires the Desktop verifier and rejects it outside the Desktop Profile before activating Connection', async () => {
  for (const [mode, supplied] of [
    ['desktop', false],
    ['desktop', true],
    ['web', true],
  ] as const) {
    const ctx = context();
    ctx.provide('runtimeIdentity', identity(mode));
    await ctx.plugin(MemoryCredentials);
    if (supplied)
      ctx.provide('desktopAuthenticationVerifier', createDesktopAuthentication().verifier);
    const fiber = ctx.plugin(Connection);
    await expect(fiber).rejects.toThrow(
      mode === 'web'
        ? 'DESKTOP_AUTH_WRONG_PROFILE'
        : supplied
          ? 'DESKTOP_AUTH_INVALID_VERIFIER'
          : 'DESKTOP_AUTH_VERIFIER_REQUIRED',
    );
    expect(ctx.get('connection')).toBeUndefined();
    await fiber.dispose();
  }
});
it('admits real authenticated HTTP while independently rejecting hostile Origin, URL credentials and cookie exchange', async () => {
  const f = await fixture();
  const headers = { [DESKTOP_AUTH_HEADER]: f.auth.credential };
  expect((await fetch(f.origin + '/api/probe')).status).toBe(401);
  expect((await fetch(f.origin + '/api/probe', { headers })).status).toBe(200);
  expect(
    (
      await fetch(f.origin + '/api/probe', {
        headers: { ...headers, origin: 'https://untrusted.invalid' },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(f.origin + '/api/probe?token=forbidden', { headers })).status).toBe(401);
  const response = await fetch(f.origin + '/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: f.auth.credential }),
  });
  expect(response.status).toBe(404);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(f.writes).not.toHaveBeenCalled();
  await expect(f.host.connection.createLaunchTokenFile('/must-not-be-created')).rejects.toThrow(
    'DESKTOP_AUTH_FILE_FORBIDDEN',
  );
  expect(f.host.connection.authenticatedUrl(f.origin + '/')).toBe(f.origin + '/');
  expect(() => f.host.connection.authenticatedUrl(f.origin + '/?token=forbidden')).toThrow(
    'DESKTOP_AUTH_INVALID_URL',
  );
  const injected = JSON.stringify(
    f.host.webServer.collectIndexInjections(f.host.connection.browserPeer),
  );
  expect(injected).not.toContain(f.auth.credential);
  expect(injected).not.toContain(f.auth.verifier.digest);
});
it('runs real generated Remote calls and the runtime Client model over header-authenticated HTTP/WebSocket', async () => {
  const f = await fixture();
  const client = context();
  await client.plugin(Registry);
  installConnection(client, {
    interactions: 'answer',
    transport: {
      streamBaseUrl: f.origin + '/',
      fetch: (input, init) =>
        fetch(new URL(input, f.origin + '/'), {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            [DESKTOP_AUTH_HEADER]: f.auth.credential,
          },
        }),
      createWebSocket: (url) =>
        new WebSocket(url, {
          headers: { [DESKTOP_AUTH_HEADER]: f.auth.credential, origin: f.origin },
        }) as unknown as ConnectionWebSocket,
    },
  });
  await client.plugin(ClientGateway);
  await client.plugin(DesktopClient);
  expect(await client.remote.desktop.health()).toEqual({ ok: true, value: { status: 'ok' } });
  await vi.waitFor(() => expect(client.desktopRuntimeModel.getSnapshot().status).toBe('ready'));
  const state = client.desktopRuntimeModel.getSnapshot();
  if (state.status !== 'ready') throw new Error('Missing runtime model');
  expect(state.baseline.metadata.generation).toBe(f.auth.verifier.generation);
});
it('rejects stale credentials after generation rotation and rejects unauthenticated stream upgrades', async () => {
  const first = await fixture();
  const second = await fixture();
  expect(
    (
      await fetch(second.origin + '/api/probe', {
        headers: { [DESKTOP_AUTH_HEADER]: first.auth.credential },
      })
    ).status,
  ).toBe(401);
  const socket = new WebSocket(second.origin.replace('http:', 'ws:') + REMOTE_STREAM_MUX_PATH, {
    headers: { origin: second.origin },
  });
  // The actual gateway path is exported by its protocol rather than supplied by page state.
  socket.on('error', () => {});
  const result = await new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      socket.close();
      reject(new Error('Unauthenticated stream admitted'));
    });
  });
  expect(result).toBe(401);
  const connection = first.host.connection;
  await first.connection.dispose();
  expect(
    connection.requestRejection({
      headers: { host: new URL(first.origin).host, [DESKTOP_AUTH_HEADER]: first.auth.credential },
    }),
  ).toBe(401);
});

it('does not let browser logout revoke the Shell-owned Desktop header credential', async () => {
  const f = await fixture(),
    headers = { [DESKTOP_AUTH_HEADER]: f.auth.credential };
  expect((await fetch(f.origin + '/api/probe', { headers })).status).toBe(200);
  expect((await fetch(f.origin + '/connect', { method: 'DELETE', headers })).status).toBe(403);
  expect((await fetch(f.origin + '/api/probe', { headers })).status).toBe(200);
});
