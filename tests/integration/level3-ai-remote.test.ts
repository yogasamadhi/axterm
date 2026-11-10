import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import WebServer from '@axterm/infra-web-server';
import Registry from '@axterm/infra-typert-registry';
import * as Connection from '@axterm/infra-connection';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import Engines from '../../packages/infra/engines/src/index.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import Access from '../../packages/infra/remote-access/src/index.ts';
import Gateway from '../../packages/infra/gateway/src/index.ts';
import RemoteEvents from '../../packages/infra/gateway/src/events.ts';
import * as ClientGateway from '../../packages/infra/gateway/src/client/index.ts';
import {
  installConnection,
  type ConnectionHandle,
  type ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
import { OwnedAiApplication } from '../../packages/plugins/ai/src/adapters/application-owner.ts';
import { AiController } from '../../packages/plugins/ai/src/controller.ts';
import { AiProjection } from '../../packages/plugins/ai/src/client/projection.ts';
import { AiModel } from '../../packages/plugins/ai/src/client/index.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { validateTypertManifest } from '../../packages/infra/typert-loader/src/index.ts';
import remote from '../../packages/plugins/ai/lib/typert.remote-client.js';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('serves generated AI methods and durable metadata over authenticated HTTP/WS, with atomic receipts and a real Pi execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ai-remote-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  let requests = 0;
  const listener = createServer((request, response) => {
    requests++;
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', 'Visible REMOTE_AI_') +
          piSseText('openai-chat', 'KEY_CANARY done') +
          piSseEnd('openai-chat'),
      );
    });
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  cleanup.push(async () => {
    const done = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await done;
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  const host = new Context();
  cleanup.push(() => host.fiber.dispose());
  const generation = randomUUID();
  host.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'web',
    appVersion: '0.10.0',
  });
  const ref = 'cred_' + randomUUID();
  await host.plugin(MemoryCredentials, {
    [encodeOpaqueCredentialRef(ref)]: 'REMOTE_AI_KEY_CANARY',
  });
  await host.plugin(Registry);
  await host.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await host.plugin(Connection);
  await host.plugin(Access);
  await host.plugin(Gateway);
  await host.plugin(RemoteEvents);
  await host.plugin(Storage);
  await host.plugin(Schema);
  await host.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await host.plugin(Domains, { backend: 'relational' });
  await host.plugin(Engines);
  await host.plugin(LocalSubprocess);
  await host.plugin(DesktopTasks);
  host.engines.register(
    'pi',
    new PiEngineProvider(host, piEngineConfigSchema.parse({ providers: {} })),
  );
  const owner = new OwnedAiApplication(
    host,
    {
      profile: 'web',
      coordinationDirectory: join(home, 'coordination'),
      localHome: home,
      remoteWorkspace: join(home, 'workspace'),
    },
    { publish: () => {} },
  );
  cleanup.push(() => owner.close());
  const application = await owner.ready();
  new AiController(host, application, owner, 'web');
  const artifact = await import('../../packages/plugins/ai/lib/typert.host.js');
  const unregister = host.typert.register(
    validateTypertManifest('@axterm/plugin-ai', artifact.TYPERT),
  );
  cleanup.push(async () => {
    unregister();
  });
  const origin = host.webServer.getOrigin();
  const token = (await readFile(await host.connection.createLaunchTokenFile(home), 'utf8')).trim();
  const auth = await fetch(origin + '/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  expect(auth.status).toBe(200);
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const client = new Context();
  cleanup.push(() => client.fiber.dispose());
  await client.plugin(Registry);
  const wire: string[] = [];
  const sockets: WebSocket[] = [];
  installConnection(client, {
    interactions: 'answer',
    transport: {
      streamBaseUrl: origin + '/',
      fetch: (input, init) =>
        fetch(new URL(input, origin + '/'), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
        }),
      createWebSocket: (url) => {
        const socket = new WebSocket(url, { headers: { cookie, origin } });
        sockets.push(socket);
        socket.on('message', (data) => wire.push(data.toString()));
        return socket as unknown as ConnectionWebSocket;
      },
    },
  });
  await client.plugin(ClientGateway);
  const unmount = await client.remote.$mount(remote);
  cleanup.push(unmount);
  const ai = new AiModel(client);
  cleanup.push(() => ai.dispose());
  await vi.waitFor(() => expect(ai.getSnapshot().status).toBe('ready'));
  const abort = new AbortController();
  const stream = client.remote.ai.watchAi(abort.signal)[Symbol.asyncIterator]();
  cleanup.push(async () => {
    abort.abort();
    await stream.return?.();
  });
  const projection = new AiProjection();
  const nextBaseline = async () => {
    for (;;) {
      const frame = await stream.next();
      if (frame.done) throw new Error('stream closed');
      const value = projection.accept(frame.value);
      if (value) return value;
    }
  };
  const initial = await nextBaseline();
  expect(initial.generation).toBe(generation);
  expect(initial.providers).toEqual([]);
  const key = randomUUID();
  const input = {
    name: 'Saved',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    credentialRef: ref,
    enabled: true,
  };
  const created = await client.remote.ai.createProvider(key, generation, input);
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  expect(await client.remote.ai.createProvider(key, generation, input)).toEqual(created);
  expect(
    (await client.remote.ai.createProvider(key, generation, { ...input, name: 'different' })).ok,
  ).toBe(false);
  expect((await client.remote.ai.createProvider(randomUUID(), randomUUID(), input)).ok).toBe(false);
  const providerId = created.value.ids[0]!;
  const observed = await nextBaseline();
  expect(observed.providers.map((item) => item.id)).toEqual([providerId]);
  const model = await ai.createModel(randomUUID(), {
    name: 'Selected',
    providerId,
    model: 'remote-fixture',
    capabilities: ['chat'],
  });
  const runKey = randomUUID();
  const runInput = {
    modelId: model.ids[0]!,
    useCase: 'chat' as const,
    prompt: 'Visible request',
    context: '',
  };
  const run = await client.remote.ai.startRun(runKey, generation, runInput);
  if (!run.ok) throw run.error;
  let result = '';
  await vi.waitFor(async () => {
    const current = await client.remote.ai.getRun(run.value.id);
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.value.state).toBe('succeeded');
      result = current.value.result ?? '';
    }
  });
  expect(result).toBe('Visible [REDACTED_KNOWN_SECRET] done');
  expect(requests).toBe(1);
  const logs = await client.remote.ai.getLog(run.value.id, { after: 0, limit: 100 });
  if (!logs.ok) throw logs.error;
  expect(logs.value.hasMore).toBe(false);
  const selected = await ai.openRun(run.value.id);
  await vi.waitFor(() => {
    expect(selected.getSnapshot().status).toBe('ready');
    expect(selected.getSnapshot().visible.run.state).toBe('succeeded');
    expect(selected.getSnapshot().visible.output).toBe(result);
    expect(selected.getSnapshot().visible.cursor).toBe(logs.value.nextCursor);
  });
  const cursor = selected.getSnapshot().visible.cursor;
  const beforeReconnect = sockets.length;
  for (const socket of sockets) socket.terminate();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(beforeReconnect));
  await vi.waitFor(() =>
    expect((client.get('connection') as unknown as ConnectionHandle).state.getSnapshot()).toBe(
      'connected',
    ),
  );
  await ai.createConversation(randomUUID(), {
    name: 'After reconnect',
    modelId: model.ids[0]!,
    useCase: 'chat',
  });
  await vi.waitFor(() => expect(ai.getSnapshot().status).toBe('ready'));
  expect(selected.getSnapshot().visible.output).toBe(result);
  expect(selected.getSnapshot().visible.cursor).toBe(cursor);
  expect(requests).toBe(1);
  expect((await client.remote.ai.startRun(runKey, generation, runInput)).ok).toBe(true);
  expect(requests).toBe(1);
  expect(JSON.stringify(wire)).not.toContain('REMOTE_AI_KEY_CANARY');
  let externalRuns = 0;
  host.engines.register('external-fixture', {
    label: 'External fixture',
    capabilities: { cancellation: true, tools: false, resume: false },
    openSession: async () => ({
      run: async (_input, context) => {
        externalRuns++;
        await context.emit({ type: 'delta', text: 'Selected external application result' });
        await context.emit({ type: 'completed' });
      },
      close: async () => {},
    }),
  });
  const externalProvider = await ai.createProvider(randomUUID(), {
    name: 'External Engine without HTTP or Vault',
    engineId: 'external-fixture',
    enabled: true,
  });
  const externalModel = await ai.createModel(randomUUID(), {
    name: 'External model',
    providerId: externalProvider.ids[0]!,
    model: 'external',
    capabilities: ['chat'],
  });
  const externalInput = {
    modelId: externalModel.ids[0]!,
    useCase: 'chat' as const,
    prompt: 'External request',
    context: '',
  };
  const externalKey = randomUUID();
  const externalRun = await ai.startRun(externalKey, externalInput);
  await vi.waitFor(async () => {
    expect(await ai.getRun(externalRun.id)).toMatchObject({
      state: 'succeeded',
      engineId: 'external-fixture',
      result: 'Selected external application result',
    });
  });
  expect((await ai.startRun(externalKey, externalInput)).id).toBe(externalRun.id);
  expect(externalRuns).toBe(1);
  expect(requests).toBe(1);
  const externalDetail = await ai.readProvider(externalProvider.ids[0]!);
  expect(externalDetail.baseUrl).toBeUndefined();
  expect(externalDetail.credentialRef).toBeUndefined();
  await expect(ai.testProvider(externalProvider.ids[0]!)).rejects.toMatchObject({
    code: 'ai/failure',
    details: { reason: 'unsupported' },
  });
  await expect(
    ai.updateProvider(
      randomUUID(),
      externalDetail.id,
      { engineId: 'pi' },
      `"v${externalDetail.version}"`,
    ),
  ).rejects.toMatchObject({
    code: 'ai/failure',
    details: { reason: 'invalid' },
  });
  expect((await ai.readProvider(externalDetail.id)).engineId).toBe('external-fixture');
  abort.abort();
  await stream.return?.();
  await ai.dispose();
  expect(ai.dispose()).toBe(ai.dispose());
  expect(() => ai.getRun(run.value.id)).toThrow('AI_MODEL_CLOSED');
  await owner.close();
  expect(owner.activeTaskCount()).toBe(0);
  expect((await client.remote.ai.getCatalog()).ok).toBe(false);
});
