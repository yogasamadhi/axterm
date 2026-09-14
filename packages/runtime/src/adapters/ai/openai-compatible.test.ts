import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ModelEvent } from '../../ports/model-provider';
import { OpenAiCompatibleProvider } from './openai-compatible';

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

async function events(provider: OpenAiCompatibleProvider): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of provider.stream({
    model: 'test-model',
    system: 'terminal expert',
    prompt: 'explain ls',
    context: 'bounded context',
    signal: new AbortController().signal,
  }))
    result.push(event);
  return result;
}

describe('AI provider protocol adapter', () => {
  it('builds OpenAI Chat requests and parses fragmented text, usage and tool calls', async () => {
    const requests: Array<{
      url: string;
      authorization?: string | undefined;
      body?: Record<string, unknown>;
    }> = [];
    const fixture = await listen(async (request, response) => {
      if (request.url === '/v1/models') {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'gpt-test' }] }));
        return;
      }
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: await body(request),
      });
      sse(response, [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"name":"inspect","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    try {
      const provider = new OpenAiCompatibleProvider(fixture.baseUrl, 'local-secret');
      await expect(provider.listModels()).resolves.toEqual(['gpt-test']);
      const result = await events(provider);
      expect(requests[0]).toMatchObject({
        url: '/v1/models',
        authorization: 'Bearer local-secret',
      });
      expect(requests[1]?.body).toMatchObject({ model: 'test-model', stream: true });
      expect(JSON.stringify(requests[1]?.body)).toContain('bounded context');
      expect(result.filter((event) => event.type === 'delta')).toEqual([
        { type: 'delta', text: 'Hel' },
        { type: 'delta', text: 'lo' },
      ]);
      expect(result.filter((event) => event.type === 'toolCallDelta')).toEqual([
        {
          type: 'toolCallDelta',
          index: 0,
          id: 'call-1',
          name: 'inspect',
          arguments: '{"pa',
        },
        { type: 'toolCallDelta', index: 0, arguments: 'th":"/"}' },
      ]);
      expect(result).toContainEqual({ type: 'usage', inputTokens: 4, outputTokens: 2 });
    } finally {
      await fixture.close();
    }
  });

  it('builds OpenAI Responses requests and normalizes fragmented response events', async () => {
    let captured: Record<string, unknown> | undefined;
    const fixture = await listen(async (request, response) => {
      captured = await body(request);
      sse(response, [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"inspect","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"item-1","delta":"{\\"host\\":"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Ready"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
      ]);
    });
    try {
      const provider = new OpenAiCompatibleProvider(fixture.baseUrl, 'local-secret', {
        protocol: 'openai-responses',
        apiPath: '/responses',
      });
      const result = await events(provider);
      expect(captured).toMatchObject({
        model: 'test-model',
        instructions: 'terminal expert',
        stream: true,
      });
      expect(captured?.input).toContain('bounded context');
      expect(result).toContainEqual({ type: 'delta', text: 'Ready' });
      expect(result).toContainEqual({
        type: 'toolCallDelta',
        index: 1,
        id: 'call-1',
        name: 'inspect',
        arguments: undefined,
      });
      expect(result).toContainEqual({
        type: 'toolCallDelta',
        index: 1,
        id: 'item-1',
        name: undefined,
        arguments: '{"host":',
      });
      expect(result).toContainEqual({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    } finally {
      await fixture.close();
    }
  });

  it('builds Anthropic requests and normalizes text, token and tool events', async () => {
    let apiKey = '';
    let version = '';
    let captured: Record<string, unknown> | undefined;
    const fixture = await listen(async (request, response) => {
      apiKey = String(request.headers['x-api-key']);
      version = String(request.headers['anthropic-version']);
      captured = await body(request);
      sse(response, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Safe"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"inspect","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/\\"}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    });
    try {
      const provider = new OpenAiCompatibleProvider(fixture.baseUrl, 'anthropic-secret', {
        protocol: 'anthropic',
        apiPath: '/messages',
        auth: 'x-api-key',
      });
      const result = await events(provider);
      expect(apiKey).toBe('anthropic-secret');
      expect(version).toBe('2023-06-01');
      expect(captured).toMatchObject({
        model: 'test-model',
        system: 'terminal expert',
        max_tokens: 4096,
        stream: true,
      });
      expect(result).toContainEqual({ type: 'delta', text: 'Safe' });
      expect(result).toContainEqual({ type: 'usage', inputTokens: 5 });
      expect(result).toContainEqual({ type: 'usage', outputTokens: 4 });
      expect(result).toContainEqual({
        type: 'toolCallDelta',
        index: 1,
        id: 'tool-1',
        name: 'inspect',
        arguments: '{}',
      });
    } finally {
      await fixture.close();
    }
  });

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
      const provider = new OpenAiCompatibleProvider(fixture.baseUrl, 'local-secret', {
        proxy: {
          url: `http://127.0.0.1:${address.port}`,
          username: 'operator',
          password: 'proxy-secret',
        },
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
      const provider = new OpenAiCompatibleProvider(fixture.baseUrl, 'local-secret');
      await expect(provider.listModels()).rejects.toThrow('Model provider rejected request (401)');
      await expect(provider.listModels()).rejects.not.toThrow(/upstream-secret|local-secret/);
    } finally {
      await fixture.close();
    }
  });
});
