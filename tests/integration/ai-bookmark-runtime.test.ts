import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeClient } from '../../packages/client/src/api-client';
import { startRuntime } from '../../packages/runtime/src/bootstrap/runtime';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
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
    await once(server, 'close').catch(() => undefined);
  });
  return `http://127.0.0.1:${address.port}`;
}

async function waitForTerminalRun(client: ReturnType<typeof createRuntimeClient>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await client.aiRun(runId);
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('AI bookmark run did not finish');
}

describe('AI bookmark Runtime boundary', () => {
  it('normalizes a safe draft and never persists secret-bearing invalid output', async () => {
    const hostToken = randomUUID();
    let requestCount = 0;
    const modelUrl = await listen((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.on('end', () => {
        requestCount += 1;
        const result =
          requestCount === 1
            ? {
                name: 'Staging API',
                title: 'API staging',
                hostname: 'staging.example.com',
                port: 2222,
                username: 'deploy',
                authType: 'privateKey',
                description: 'Staging application server',
                favorite: true,
              }
            : {
                name: 'Unsafe',
                title: 'Unsafe',
                hostname: 'unsafe.example.com',
                port: 22,
                username: 'root',
                authType: 'password',
                description: '',
                favorite: false,
                password: 'model-invented-secret',
              };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\n`,
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
    const runtime = await startRuntime({
      generation: randomUUID(),
      appVersion: '0.10.0',
      mode: 'headless',
      hostCapabilityUrl: hostUrl,
      hostCapabilityToken: hostToken,
    });
    cleanup.push(() => runtime.close());
    const client = createRuntimeClient({ resolve: async () => runtime.bootstrap() });
    cleanup.push(async () => client.dispose());
    const provider = await client.createAiProvider({
      name: 'Bookmark fixture',
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

    const safe = await waitForTerminalRun(
      client,
      (
        await client.startAi({
          modelId: model.id,
          useCase: 'createBookmark',
          prompt: 'Create the staging bookmark',
          context: '',
        })
      ).id,
    );
    expect(safe).toMatchObject({ state: 'succeeded', useCase: 'createBookmark' });
    expect(JSON.parse(safe.result!)).toMatchObject({
      hostname: 'staging.example.com',
      port: 2222,
      authType: 'privateKey',
    });

    const unsafe = await waitForTerminalRun(
      client,
      (
        await client.startAi({
          modelId: model.id,
          useCase: 'createBookmark',
          prompt: 'Create another bookmark',
          context: '',
        })
      ).id,
    );
    expect(unsafe).toMatchObject({ state: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
    expect(unsafe.result).toBeUndefined();
    expect(JSON.stringify(await client.aiRuns())).not.toContain('model-invented-secret');
  });
});
