import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderProtocol } from '../../packages/contracts/src';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

import { piSseStart, piSseText, piSseEnd, piSseHidden } from '../fixtures/pi-sse';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${address.port}`;
}
const protocols: AiProviderProtocol[] = ['openai-chat', 'openai-responses', 'anthropic'];
describe.each(protocols)('reviewed %s Runtime HTTP lifecycle', (protocol) => {
  it('previews without model work, binds sending, cancels a partial stream and masks failures', async () => {
    const secret = 'known-runtime-context-canary';
    const hostToken = randomUUID();
    const host = await listen((request, response) => {
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify(
          request.url === '/host/v1/updater/status' ? { state: 'disabled' } : { secret },
        ),
      );
    });
    let mode: 'success' | 'cancel' | 'error' = 'success';
    const bodies: string[] = [];
    let canceledConnection = false;
    const modelUrl = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        bodies.push(body);
        if (mode === 'error') {
          response.writeHead(401);
          response.end('UPSTREAM_SECRET_CANARY');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          piSseStart(protocol) +
            piSseHidden(protocol) +
            piSseText(protocol, mode === 'cancel' ? 'partial visible' : 'safe answer'),
        );
        if (mode === 'cancel')
          response.once('close', () => {
            canceledConnection = true;
          });
        else response.end(piSseEnd(protocol));
      });
    });
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: host,
      hostCapabilityToken: hostToken,
    });
    cleanup.push(() => runtime.close());
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    cleanup.push(async () => client.dispose());
    const eventController = new AbortController();
    const events: Array<{ type: string; data: unknown }> = [];
    const streaming = client.eventStream(
      'realtime',
      (event) => {
        if (events.length < 100) events.push(event);
      },
      eventController.signal,
    );
    cleanup.push(async () => {
      eventController.abort();
      await streaming;
    });
    await vi.waitFor(async () =>
      expect((await client.diagnostics()).resources.realtimeSubscribers).toBe(1),
    );
    const provider = await client.createAiProvider({
      name: 'loopback context',
      baseUrl: modelUrl + '/v1/',
      protocol,
      apiPath:
        protocol === 'openai-chat'
          ? '/chat/completions'
          : protocol === 'openai-responses'
            ? '/responses'
            : '/messages',
      auth: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
      role: `expert ${secret}`,
      timeoutMs: 5_000,
      credentialRef: 'ai-key',
      enabled: true,
      proxy: null,
    });
    const model = await client.createAiModel({
      name: 'fixture',
      providerId: provider.id,
      model: 'fixture-model',
      capabilities: ['chat'],
    });
    const input = {
      modelId: model.id,
      useCase: 'diagnose' as const,
      prompt: `inspect ${secret}`,
      context: 'password=context-canary',
      includeConversationHistory: false,
    };
    const preview = await client.previewAiContext(input);
    expect(bodies).toEqual([]);
    expect(await client.aiRuns()).toEqual([]);
    expect(JSON.stringify(preview)).not.toMatch(
      /known-runtime-context-canary|context-canary|ai-key/u,
    );
    const reviewed = {
      ...preview.request,
      reviewReceipt: preview.reviewReceipt,
      reviewExpiresAt: preview.reviewExpiresAt,
    };
    await expect(client.startAi({ ...reviewed, terminalId: randomUUID() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(bodies).toEqual([]);
    const run = await client.startAi(reviewed);
    await vi.waitFor(async () =>
      expect(await client.aiRun(run.id)).toMatchObject({
        state: 'succeeded',
        result: 'safe answer',
      }),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(preview.prompt);
    expect(bodies[0]).not.toMatch(/known-runtime-context-canary|context-canary/u);
    expect(JSON.stringify(await client.aiRun(run.id))).not.toContain('HIDDEN_REASONING_CANARY');
    mode = 'cancel';
    const partial = await client.startAi({ ...input, prompt: 'cancel stream' });
    await vi.waitFor(async () =>
      expect(
        events.some(
          (event) =>
            event.type === 'ai.run.delta' &&
            JSON.stringify(event.data).includes(partial.id) &&
            JSON.stringify(event.data).includes('partial visible'),
        ),
      ).toBe(true),
    );
    await client.cancelAi(partial.id);
    await vi.waitFor(async () => expect((await client.aiRun(partial.id)).state).toBe('canceled'));
    await vi.waitFor(() => expect(canceledConnection).toBe(true));
    expect(JSON.stringify(events)).not.toContain('HIDDEN_REASONING_CANARY');
    mode = 'error';
    const rejected = await client.startAi({ ...input, prompt: 'rejected stream' });
    await vi.waitFor(async () => expect((await client.aiRun(rejected.id)).state).toBe('failed'));
    expect(JSON.stringify(await client.aiRun(rejected.id))).not.toMatch(
      /UPSTREAM_SECRET_CANARY|HIDDEN_REASONING_CANARY|known-runtime-context-canary/u,
    );
  });
});
