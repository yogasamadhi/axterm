import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src';
import type { AiRunEvent } from '../../packages/contracts/src';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';
import { piSseEnd, piSseText } from '../fixtures/pi-sse';

it('streams Pi text before completion, resumes from snapshots, and retains canceled partial text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-ai-stream-'));
  let modelResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/resolve')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ secret: 'isolated-fixture-key' }));
      return;
    }
    request.resume();
    request.on('end', () => {
      modelResponse = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piSseText('openai-chat', '第一段🙂'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model listener');
  const url = `http://127.0.0.1:${address.port}`;
  const runtime = await startRuntime({
    generation: randomUUID(),
    appVersion: '0.10.0',
    mode: 'headless',
    dataDirectory: root,
    hostCapabilityUrl: url,
    hostCapabilityToken: randomUUID(),
  });
  const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
  const streams: AbortController[] = [];
  try {
    const provider = await client.createAiProvider({
      name: 'Pi stream fixture',
      baseUrl: `${url}/v1/`,
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      credentialRef: 'fixture-key',
      timeoutMs: 10_000,
      enabled: true,
    });
    const model = await client.createAiModel({
      providerId: provider.id,
      name: 'Fixture',
      model: 'fixture',
      capabilities: ['chat'],
    });
    const conversation = await client.createAiConversation({
      name: 'Stream fixture',
      modelId: model.id,
      useCase: 'chat',
    });
    const start = () =>
      client.startAi({
        modelId: model.id,
        conversationId: conversation.id,
        mode: 'chat',
        useCase: 'chat',
        prompt: 'hello',
        context: '',
      });
    const run = await start();
    await expect.poll(async () => (await client.aiRun(run.id)).result).toBe('第一段🙂');
    expect((await client.aiRun(run.id)).state).toBe('running');
    const events: AiRunEvent[] = [];
    const connect = () => {
      const controller = new AbortController();
      streams.push(controller);
      return {
        controller,
        task: client.streamAiRun(run.id, (event) => events.push(event), controller.signal),
      };
    };
    const first = connect();
    await expect
      .poll(() => events[0])
      .toMatchObject({ type: 'snapshot', data: { result: '第一段🙂', state: 'running' } });
    modelResponse!.write(piSseText('openai-chat', '，第二段'));
    await expect
      .poll(() => events.find((event) => event.type === 'delta'))
      .toMatchObject({ data: { text: '，第二段' } });
    first.controller.abort();
    await first.task;
    expect((await client.aiRun(run.id)).state).toBe('running');
    events.length = 0;
    const resumed = connect();
    await expect
      .poll(() => events[0])
      .toMatchObject({ type: 'snapshot', data: { result: '第一段🙂，第二段' } });
    modelResponse!.end(piSseText('openai-chat', '，结尾') + piSseEnd('openai-chat'));
    await resumed.task;
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      data: { state: 'succeeded', result: '第一段🙂，第二段，结尾' },
    });
    expect(
      (await client.aiConversation(conversation.id)).messages.filter(
        (item) => item.role === 'assistant',
      ),
    ).toMatchObject([{ content: '第一段🙂，第二段，结尾' }]);
    // A late subscription to a completed run must close, without waiting for another state event.
    events.length = 0;
    await connect().task;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'snapshot', data: { state: 'succeeded' } });
    const canceled = await start();
    await expect.poll(async () => (await client.aiRun(canceled.id)).result).toBe('第一段🙂');
    await client.cancelAi(canceled.id);
    await expect.poll(async () => (await client.aiRun(canceled.id)).state).toBe('canceled');
    expect((await client.aiRun(canceled.id)).result).toBe('第一段🙂');
    expect((await client.aiConversation(conversation.id)).messages.at(-1)).toMatchObject({
      role: 'assistant',
      state: 'canceled',
      content: '第一段🙂',
    });
  } finally {
    streams.forEach((stream) => stream.abort());
    client.dispose();
    await runtime.close();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
