import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AiProviderProtocol } from '@workspace/contracts';
import type { ModelEvent } from '../../ports/model-provider';
import { PiModelProvider } from './pi-provider';
import {
  piTestProvider,
  piSseStart,
  piSseText,
  piSseFragmentedCommand,
} from '../../../../../tests/fixtures/pi-sse';

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('AI fixture did not listen');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sse(response: ServerResponse, chunks: string[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

async function events(provider: PiModelProvider): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of provider.stream({
    model: 'test-model',
    system: 'terminal expert',
    prompt: 'explain ls',
    context: 'bounded context',
    signal: new AbortController().signal,
    allowCommandProposal: true,
  }))
    result.push(event);
  return result;
}

describe('Pi protocols and legacy model discovery', () => {
  it.each(['openai-chat', 'openai-responses', 'anthropic'] as AiProviderProtocol[])(
    'uses Pi for %s requests and fragmented text, usage and command arguments',
    async (protocol) => {
      const requests: Array<{
        url: string;
        auth?: string;
        version?: string;
        body?: Record<string, unknown>;
      }> = [];
      const fixture = await listen(async (request, response) => {
        const auth = String(
          protocol === 'anthropic' ? request.headers['x-api-key'] : request.headers.authorization,
        );
        if (request.url === '/v1/models') {
          requests.push({ url: request.url, auth });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'gpt-test' }] }));
          return;
        }
        requests.push({
          url: request.url ?? '',
          auth,
          version: String(request.headers['anthropic-version'] ?? ''),
          body: await body(request),
        });
        const text =
          piSseStart(protocol) +
          piSseText(protocol, 'Hel') +
          piSseText(protocol, 'lo') +
          piSseFragmentedCommand(protocol, 'pwd');
        // Deliberately split an SSE frame on the wire; framing and tools are parsed by Pi.
        sse(response, [text.slice(0, 11), text.slice(11)]);
      });
      try {
        const provider = new PiModelProvider(
          piTestProvider(fixture.baseUrl, protocol),
          'local-secret',
          null,
        );
        await expect(provider.listModels()).resolves.toEqual(['gpt-test']);
        const result = await events(provider);
        expect(requests[0]).toMatchObject({
          url: '/v1/models',
          auth: protocol === 'anthropic' ? 'local-secret' : 'Bearer local-secret',
        });
        expect(requests[1]?.body).toMatchObject({ model: 'test-model', stream: true });
        expect(requests[1]?.url).toBe(
          protocol === 'anthropic'
            ? '/v1/messages'
            : protocol === 'openai-responses'
              ? '/v1/responses'
              : '/v1/chat/completions',
        );
        expect(JSON.stringify(requests[1]?.body)).toContain('terminal expert');
        expect(JSON.stringify(requests[1]?.body)).toContain('bounded context');
        if (protocol === 'anthropic') {
          expect(requests[1]?.version).toBe('2023-06-01');
          expect(requests[1]?.body).toMatchObject({ max_tokens: 4096 });
        }
        expect(result.filter((event) => event.type === 'delta')).toEqual([
          { type: 'delta', text: 'Hel' },
          { type: 'delta', text: 'lo' },
        ]);
        expect(result).toContainEqual({ type: 'commandProposal', command: 'pwd' });
        expect(result).toContainEqual({ type: 'usage', inputTokens: 3, outputTokens: 2 });
        expect(result.at(-1)).toEqual({ type: 'completed' });
      } finally {
        await fixture.close();
      }
    },
  );

  it('routes model discovery through an authenticated HTTP CONNECT proxy', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ models: [{ name: 'proxied-model' }] }));
    });
    let authorization = '';
    const sockets = new Set<Socket>();
    const proxy = createServer();
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (request, client) => {
      authorization = String(request.headers['proxy-authorization'] ?? '');
      const [host, rawPort] = (request.url ?? '').split(':');
      const upstream = connect(Number(rawPort), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
      });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy fixture did not listen');
    try {
      const provider = new PiModelProvider(piTestProvider(fixture.baseUrl), 'local-secret', {
        url: `http://127.0.0.1:${address.port}`,
        username: 'operator',
        password: 'proxy-secret',
      });
      await expect(provider.listModels()).resolves.toEqual(['proxied-model']);
      expect(authorization).toBe(
        `Basic ${Buffer.from('operator:proxy-secret').toString('base64')}`,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      proxy.close();
      await once(proxy, 'close');
      await fixture.close();
    }
  });

  it('returns a stable provider error without exposing response bodies or credentials', async () => {
    const fixture = await listen((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'token=upstream-secret' }));
    });
    try {
      const provider = new PiModelProvider(piTestProvider(fixture.baseUrl), 'local-secret', null);
      await expect(provider.listModels()).rejects.toThrow('Model provider rejected request (401)');
      await expect(provider.listModels()).rejects.not.toThrow(/upstream-secret|local-secret/);
    } finally {
      await fixture.close();
    }
  });
});
