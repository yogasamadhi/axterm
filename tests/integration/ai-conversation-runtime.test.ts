import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close').catch(() => undefined);
  });
  return `http://127.0.0.1:${address.port}`;
}

async function waitForRun(
  client: ReturnType<typeof createRuntimeClient>,
  runId: string,
  state: 'succeeded' | 'failed' | 'canceled' = 'succeeded',
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await client.aiRun(runId);
    if (run.state === state) return run;
    if (['succeeded', 'failed', 'canceled'].includes(run.state))
      throw new Error(`Run entered ${run.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('AI run did not finish');
}

describe('AI conversation Runtime boundary', () => {
  it('persists, resumes, cancels and deletes a versioned chat session', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'axterm-ai-chat-'));
    cleanup.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const hostToken = randomUUID();
    const requests: string[] = [];
    let requestCount = 0;
    const modelUrl = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        requests.push(body);
        requestCount += 1;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        if (requestCount === 3) return;
        const answer = requestCount === 1 ? 'first answer' : 'second answer';
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      });
    });
    const hostUrl = await listen((request, response) => {
      if (request.headers.authorization !== `Bearer ${hostToken}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === 'POST' && request.url?.endsWith('/resolve')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ secret: 'application-local-ai-secret' }));
        return;
      }
      response.writeHead(404).end();
    });

    const start = () =>
      startRuntime({
        generation: randomUUID(),
        appVersion: '0.10.0',
        mode: 'headless',
        dataDirectory,
        hostCapabilityUrl: hostUrl,
        hostCapabilityToken: hostToken,
      });
    let runtime = await start();
    let client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    const provider = await client.createAiProvider({
      name: 'Chat fixture',
      baseUrl: `${modelUrl}/v1/`,
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      role: 'Terminal expert',
      proxy: null,
      timeoutMs: 5_000,
      credentialRef: 'ai-key',
      enabled: true,
    });
    const model = await client.createAiModel({
      providerId: provider.id,
      name: 'Fixture',
      model: 'fixture-model',
      capabilities: ['chat'],
    });
    const conversation = await client.createAiConversation({
      name: 'Persistent session',
      modelId: model.id,
      useCase: 'diagnose',
    });
    const first = await client.startAi({
      conversationId: conversation.id,
      modelId: model.id,
      useCase: 'diagnose',
      prompt: 'first question',
      context: '',
    });
    await waitForRun(client, first.id);
    expect((await client.aiConversation(conversation.id)).messages).toMatchObject([
      { role: 'user', content: 'first question', state: 'complete' },
      { role: 'assistant', content: 'first answer', state: 'complete' },
    ]);

    client.dispose();
    await runtime.close();
    runtime = await start();
    client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    expect((await client.aiConversations())[0]).toMatchObject({
      id: conversation.id,
      messageCount: 2,
    });
    const second = await client.startAi({
      conversationId: conversation.id,
      modelId: model.id,
      useCase: 'diagnose',
      prompt: 'second question',
      context: '',
    });
    await waitForRun(client, second.id);
    expect(requests[1]).toContain('Assistant: first answer');
    expect((await client.aiConversation(conversation.id)).messages).toHaveLength(4);

    const third = await client.startAi({
      conversationId: conversation.id,
      modelId: model.id,
      useCase: 'diagnose',
      prompt: 'cancel this request',
      context: '',
    });
    await client.cancelAi(third.id);
    await waitForRun(client, third.id, 'canceled');
    const canceled = await client.aiConversation(conversation.id);
    expect(canceled.messages.at(-1)).toMatchObject({ role: 'assistant', state: 'canceled' });

    const latest = (await client.aiConversations()).find(({ id }) => id === conversation.id)!;
    await client.deleteAiConversation(latest);
    await expect(client.aiConversation(conversation.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await client.aiConversations()).some(({ id }) => id === conversation.id)).toBe(false);
    client.dispose();
    await runtime.close();
  });
});
