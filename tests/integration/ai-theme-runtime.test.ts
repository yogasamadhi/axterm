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

async function waitForRun(client: ReturnType<typeof createRuntimeClient>, runId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await client.aiRun(runId);
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('AI theme run did not finish');
}

const palette = {
  name: 'Runtime Ocean',
  terminal: {
    foreground: '#f2f7fa',
    background: '#101820',
    cursor: '#ffffff',
    cursorAccent: '#101820',
    selectionBackground: 'rgba(70, 140, 180, 0.45)',
    black: '#101820',
    red: '#ff6b6b',
    green: '#6bdb9a',
    yellow: '#ffd166',
    blue: '#63a4ff',
    magenta: '#c792ea',
    cyan: '#5eead4',
    white: '#dce7ec',
    brightBlack: '#536471',
    brightRed: '#ff8f8f',
    brightGreen: '#8ce8b2',
    brightYellow: '#ffe29a',
    brightBlue: '#8ebcff',
    brightMagenta: '#dab0f0',
    brightCyan: '#8af3e4',
    brightWhite: '#ffffff',
  },
  ui: {
    main: '#101820',
    'main-dark': '#0a1015',
    'main-light': '#1c2a34',
    text: '#f2f7fa',
    'text-light': '#ffffff',
    'text-dark': '#b7c7d0',
    'text-disabled': '#71818a',
    primary: '#4ea8de',
    info: '#63a4ff',
    success: '#6bdb9a',
    error: '#ff6b6b',
    warn: '#ffd166',
  },
} as const;

describe('AI theme Runtime boundary', () => {
  it('persists only a complete readable palette and drops invalid partial output', async () => {
    const hostToken = randomUUID();
    let requestCount = 0;
    const modelUrl = await listen((request, response) => {
      request.resume();
      request.on('end', () => {
        requestCount += 1;
        const result =
          requestCount === 1
            ? palette
            : {
                ...palette,
                terminal: { ...palette.terminal, foreground: '#111111', background: '#101010' },
                injectedCss: 'body { display: none }',
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
      name: 'Theme fixture',
      baseUrl: `${modelUrl}/v1/`,
      apiPath: '/chat/completions',
      protocol: 'openai-chat',
      auth: 'bearer',
      role: 'Theme designer',
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
    const run = await client.startAi({
      modelId: model.id,
      useCase: 'createTheme',
      prompt: 'Create a readable ocean theme',
      context: '',
    });
    const valid = await waitForRun(client, run.id);
    expect(valid).toMatchObject({ state: 'succeeded', useCase: 'createTheme' });
    expect(JSON.parse(valid.result!)).toEqual(palette);

    const invalid = await waitForRun(
      client,
      (
        await client.startAi({
          modelId: model.id,
          useCase: 'createTheme',
          prompt: 'Create an unreadable theme',
          context: '',
        })
      ).id,
    );
    expect(invalid).toMatchObject({ state: 'failed', errorCode: 'AI_OUTPUT_INVALID' });
    expect(invalid.result).toBeUndefined();
    expect(JSON.stringify(await client.aiRuns())).not.toContain('injectedCss');
  });
});
