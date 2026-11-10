import * as Sqlite from '@axterm/infra-storage-sqlite';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import WebServer from '@axterm/infra-web-server';
import Registry from '@axterm/infra-typert-registry';
import Access from '../../packages/infra/remote-access/src/index.ts';
import Gateway from '../../packages/infra/gateway/src/index.ts';
import * as Connection from '@axterm/infra-connection';
import {
  installConnection,
  type ConnectionWebSocket,
  type ConnectionHandle,
} from '../../packages/infra/connection/src/client/index.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import Desktop from '../../packages/plugins/desktop/src/index.ts';
import * as DesktopClient from '../../packages/plugins/desktop/src/client/index.ts';
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventOutcome,
  TypertRemoteEvent,
  TypertLookup,
  TypertContext,
} from '@axterm/plugin-api';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { validateTypertManifest } from '../../packages/infra/typert-loader/src/index.ts';

interface ScopeSubject {
  readonly hostOnlySecret: string;
  readonly scopeKind: 'fixture';
}
declare module '@axterm/plugin-api' {
  interface TypertLookupMap {
    scopeEventFixture: TypertLookup<ScopeSubject, string>;
  }
  interface TypertContextMap {
    scopeEventFixture: TypertContext<string>;
  }
  interface TypertRemoteEventSelection {
    'fixture/approval': true;
    'fixture/ambiguous': true;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'fixture/ambiguous'(
      this: Context,
      request: { workspace: ScopeSubject; other: ScopeSubject; signal: AbortSignal },
      next: () => Promise<boolean>,
    ): Promise<boolean>;
    'fixture/approval'(
      this: Context,
      request: { workspace: ScopeSubject; label: string; signal: AbortSignal },
      next: () => Promise<boolean>,
    ): Promise<boolean>;
  }
}

const contexts: Context[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

it('serves actual Desktop Remote methods and replaces the Client model baseline over authenticated HTTP/WebSocket', async () => {
  const host = new Context();
  contexts.push(host);
  host.provide(
    'runtimeIdentity',
    Object.freeze({
      runtimeId: randomUUID(),
      generation: randomUUID(),
      startedAt: new Date().toISOString(),
      pid: process.pid,
      mode: 'web',
      appVersion: '0.10.0',
    }),
  );
  await host.plugin(MemoryCredentials);
  await host.plugin(Storage);
  await host.plugin(Schema);
  await host.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await host.plugin(Sqlite, { path: ':memory:' });
  await host.plugin(Domains, { backend: 'relational', routes: { desktop_diagnostics: 'sqlite' } });
  await host.plugin(Registry);
  await host.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await host.plugin(Connection);
  await host.plugin(Access);
  const gateway = host.plugin(Gateway);
  await gateway;
  const controller = host.plugin(Desktop);
  await controller;
  // The module boundary validates the actual compiler artifact before registration.
  const artifact = await import('../../packages/plugins/desktop/lib/typert.host.js');
  const withdraw = host.typert.register(
    validateTypertManifest('@axterm/plugin-desktop', artifact.TYPERT),
  );
  const events: TypertRemoteEventDispatch[] = [];
  let wakeEvents: (() => void) | undefined;
  host.typertGateway.registerRemoteEvents(
    (signal) => ({
      async *[Symbol.asyncIterator]() {
        const wake = () => wakeEvents?.();
        signal.addEventListener('abort', wake, { once: true });
        try {
          while (!signal.aborted) {
            const event = events.shift();
            if (event) yield event;
            else
              await new Promise<void>((resolve) => {
                wakeEvents = resolve;
              });
          }
        } finally {
          signal.removeEventListener('abort', wake);
        }
      },
    }),
    { home: '/test-home' },
  );
  const wireFrames: string[] = [];
  const root = await mkdtemp(join(tmpdir(), 'axterm-desktop-remote-'));
  directories.push(root);
  const token = await readFile(await host.connection.createLaunchTokenFile(root), 'utf8');
  const origin = host.webServer.getOrigin();
  const auth = await fetch(origin + '/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(auth.status).toBe(200);
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const client = new Context();
  contexts.push(client);
  await client.plugin(Registry);
  installConnection(client, {
    interactions: 'answer',
    recovery: { backoffBaseMs: 10 },
    transport: {
      streamBaseUrl: origin + '/',
      fetch: (input, init) =>
        fetch(new URL(input, origin + '/'), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
        }),
      createWebSocket: (url) => {
        const socket = new WebSocket(url, { headers: { cookie, origin } });
        socket.on('message', (data) => wireFrames.push(data.toString()));
        return socket as unknown as ConnectionWebSocket;
      },
    },
  });
  const clientGateway = client.plugin(ClientGateway);
  await clientGateway;
  const modelOwner = client.plugin(DesktopClient);
  await modelOwner;
  expect(await client.remote.desktop.getRuntimeMetadata()).toMatchObject({ ok: true });
  expect(await client.remote.desktop.getDiagnostics()).toMatchObject({
    ok: true,
    value: { database: 'ok', generation: host.runtimeIdentity.generation },
  });
  host.logger.warn('HOST_FAILED', { password: 'DIAGNOSTIC_PRIVATE_ARGUMENT' });
  const diagnosticLogs = await client.remote.desktop.getDiagnosticLogs();
  expect(diagnosticLogs.ok).toBe(true);
  if (!diagnosticLogs.ok) throw Error('DIAGNOSTIC_LOG_QUERY_FAILED');
  expect(diagnosticLogs.value.lines.join('\n')).toContain('HOST_FAILED');
  expect(diagnosticLogs.value.lines.join('\n')).not.toContain('DIAGNOSTIC_PRIVATE_ARGUMENT');

  const probeAbort = new AbortController();
  const probe = client.remote.desktop.watchRuntime(probeAbort.signal)[Symbol.asyncIterator]();
  try {
    expect((await probe.next()).value).toMatchObject({ type: 'baseline' });
  } finally {
    probeAbort.abort();
    await probe.return?.();
  }
  await vi.waitFor(() => expect(client.desktopRuntimeModel.getSnapshot().status).toBe('ready'));
  expect(await client.remote.desktop.health()).toEqual({ ok: true, value: { status: 'ok' } });
  expect(await client.remote.desktop.getVersion()).toEqual({
    ok: true,
    value: { apiVersion: 'v1', appVersion: '0.10.0' },
  });
  const state = client.desktopRuntimeModel.getSnapshot();
  if (state.status !== 'ready') throw new Error('Missing Desktop baseline');
  expect(state.baseline.metadata.generation).toBe(host.runtimeIdentity.generation);
  const clientScopeOwner = client.plugin(() => {});
  await clientScopeOwner;
  const clientScope = clientScopeOwner.ctx;
  client.typert.contexts.registerClient('scopeEventFixture', {
    identity: (candidate) => (candidate === clientScope ? 'workspace-1' : undefined),
    resolve: (id) => (id === 'workspace-1' ? clientScope : undefined),
  });
  // @ts-expect-error A single wire Scope cannot project two distinct Host subjects.
  const ambiguousEvent: TypertRemoteEvent = 'fixture/ambiguous';
  expect(ambiguousEvent).toBe('fixture/ambiguous');
  const releaseApproval = client.remote.$on('fixture/approval', async (request) => {
    const resolvedContext: Context = request.workspace;
    expect(resolvedContext).toBe(clientScope);
    expect(request.label).toBe('Confirm fixture');
    return true;
  });
  const subject: ScopeSubject = {
    hostOnlySecret: 'fixture-hidden-host-subject',
    scopeKind: 'fixture',
  };
  const outcome = Promise.withResolvers<TypertRemoteEventOutcome>();
  events.push({
    event: 'fixture/approval',
    request: { workspace: subject, label: 'Confirm fixture', signal: new AbortController().signal },
    context: {
      value: host,
      subject,
      scope: { context: 'scopeEventFixture', id: 'workspace-1', subject: 'workspace' },
    },
    resolve: outcome.resolve,
    reject: outcome.reject,
  });
  wakeEvents?.();
  expect(await outcome.promise).toEqual({ kind: 'result', value: true });
  expect(wireFrames.some((frame) => frame.includes('waterfall'))).toBe(true);
  expect(wireFrames.join('')).not.toContain('fixture-hidden-host-subject');
  expect(host.typertGateway.getPendingRemoteEvents()).toEqual([]);
  releaseApproval();
  const connection = client.get('connection') as unknown as ConnectionHandle;
  const first = connection.generation.getSnapshot()!.id;
  connection.reconnect();
  await vi.waitFor(() => expect(connection.generation.getSnapshot()!.id).toBeGreaterThan(first));
  await vi.waitFor(() => expect(client.desktopRuntimeModel.getSnapshot()).not.toBe(state));
  await withdraw();
  const rejected = await client.remote.desktop.health();
  expect(rejected).toMatchObject({ ok: false, error: { code: 'gateway/definition-unavailable' } });
  await controller.dispose();
  await vi.waitFor(() => expect(client.desktopRuntimeModel.getSnapshot().status).toBe('error'));
  await modelOwner.dispose();
  expect(client.get('desktopRuntimeModel')).toBeUndefined();
  expect(client.typert.remotes.list()).toEqual([]);
  const cached = client.remote;
  const clientArtifact = await import('../../packages/plugins/desktop/lib/typert.remote-client.js');
  await expect(
    cached.$mount({
      ...clientArtifact.default,
      descriptors: clientArtifact.default.descriptors.map((descriptor) => ({
        ...descriptor,
        result: { mode: 'src-json' as const },
      })),
    }),
  ).rejects.toThrow('no strict codec');
  expect(client.typert.remotes.list()).toEqual([]);
  const rootMount = await cached.$mount(clientArtifact.default);
  expect(client.typert.remotes.list()).toHaveLength(21);
  await clientGateway.dispose();
  expect(client.typert.remotes.list()).toEqual([]);
  await expect(cached.$mount(clientArtifact.default)).rejects.toThrow();
  await rootMount();
  await gateway.dispose();
});
