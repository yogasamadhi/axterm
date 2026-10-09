import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { piCatalogProviderSchema } from '@workspace/contracts';
import { piCatalog, PiModelProvider } from './pi-provider';
import {
  piSseStart,
  piSseText,
  piSseEnd,
  piSseHidden,
  piSseCommand,
  piTestProvider as provider,
} from '../../../../../tests/fixtures/pi-sse';
import type { ModelEvent } from '../../ports/model-provider';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  cleanup.push(async () => {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${address.port}/v1`;
}
function request(signal = new AbortController().signal) {
  return {
    model: 'fixture-model',
    system: 'safe system',
    prompt: 'explain',
    context: 'reviewed context',
    signal,
  };
}
async function collect(adapter: PiModelProvider) {
  const result: ModelEvent[] = [];
  for await (const event of adapter.stream(request())) result.push(event);
  return result;
}

describe('Pi source engine adapter', () => {
  it('exposes one approval-only command proposal and keeps Pi execution blocked', async () => {
    let body = '';
    const url = await fixture((req, res) => {
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(piSseCommand('pwd'));
      });
    });
    const events: ModelEvent[] = [];
    for await (const event of new PiModelProvider(provider(url), 'key', null).stream({
      ...request(),
      allowCommandProposal: true,
    }))
      events.push(event);
    expect(events).toContainEqual({ type: 'commandProposal', command: 'pwd' });
    expect(JSON.parse(body).tools).toHaveLength(1);
    expect(body).toContain('workspace_exec');
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });
  it.each(['disabled', 'extra-args', 'truncated', 'empty'] as const)(
    'rejects %s model tool calls',
    async (mode) => {
      const url = await fixture((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          piSseCommand(
            mode === 'empty' ? ' ' : 'pwd',
            mode === 'extra-args' ? { cwd: '/wrong' } : {},
            mode === 'truncated' ? 'length' : 'tool_calls',
          ),
        );
      });
      const events: ModelEvent[] = [];
      await expect(
        (async () => {
          for await (const event of new PiModelProvider(provider(url), 'key', null).stream({
            ...request(),
            allowCommandProposal: mode !== 'disabled',
          }))
            events.push(event);
        })(),
      ).rejects.toThrow();
      expect(events.some(({ type }) => type === 'commandProposal')).toBe(false);
    },
  );
  it('serves the pinned Pi catalog as portable metadata with API-key availability', () => {
    const catalog = piCatalogProviderSchema.array().parse(piCatalog());
    expect(catalog.find(({ id }) => id === 'deepseek')).toMatchObject({ apiKeyAvailable: true });
    expect(catalog.find(({ id }) => id === 'google')?.models.length).toBeGreaterThan(0);
    expect(catalog.find(({ id }) => id === 'openai-codex')?.apiKeyAvailable).toBe(false);
    expect(JSON.stringify(catalog)).not.toMatch(/apiKey"|env"|oauth"|credential/u);
  });
  it.each(['openai-chat', 'openai-responses', 'anthropic'] as const)(
    'uses Pi for legacy %s requests, hiding reasoning and reporting usage',
    async (protocol) => {
      let body = '';
      const url = await fixture((req, res) => {
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            piSseStart(protocol) +
              piSseHidden(protocol) +
              piSseText(protocol, 'visible') +
              piSseEnd(protocol),
          );
        });
      });
      const events = await collect(
        new PiModelProvider(provider(url, protocol), 'fixture-key', null),
      );
      expect(events).toContainEqual({ type: 'delta', text: 'visible' });
      expect(events).toContainEqual({ type: 'usage', inputTokens: 3, outputTokens: 2 });
      expect(events.at(-1)).toEqual({ type: 'completed' });
      expect(JSON.stringify(events)).not.toContain('HIDDEN_REASONING_CANARY');
      expect(body).toContain('reviewed context');
      expect(body).not.toMatch(/"tools"|"execute"/u);
    },
  );
  it('merges Pi model overrides with existing compatibility metadata and Vault headers', async () => {
    let body = '';
    let header = '';
    const url = await fixture((req, res) => {
      header = String(req.headers['x-tenant-key']);
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(piSseText('openai-chat', 'custom') + piSseEnd('openai-chat'));
      });
    });
    const config = provider(url);
    config.pi = {
      id: 'ollama',
      api: 'openai-completions',
      models: [
        {
          id: 'fixture-model',
          reasoning: true,
          maxTokens: 321,
          contextWindow: 8192,
          compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        },
      ],
      modelOverrides: {
        'fixture-model': { maxTokens: 99, compat: { maxTokensField: 'max_completion_tokens' } },
      },
      headerCredentialRefs: { 'x-tenant-key': 'header-vault-ref' },
    };
    await collect(
      new PiModelProvider(config, 'key', null, { 'x-tenant-key': 'HEADER_SECRET_CANARY' }),
    );
    expect(header).toBe('HEADER_SECRET_CANARY');
    expect(JSON.parse(body)).toMatchObject({
      model: 'fixture-model',
      max_completion_tokens: 99,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(body).not.toContain('HEADER_SECRET_CANARY');
  });
  it('applies additive defaults to an older saved provider configuration', async () => {
    let path = '';
    const url = await fixture((req, res) => {
      path = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseText('openai-chat', 'legacy') + piSseEnd('openai-chat'));
    });
    const saved = provider(url);
    for (const field of ['protocol', 'auth', 'apiPath', 'role', 'proxy', 'timeoutMs'])
      Reflect.deleteProperty(saved, field);
    expect(await collect(new PiModelProvider(saved, 'key', null))).toContainEqual({
      type: 'delta',
      text: 'legacy',
    });
    expect(path).toBe('/v1/chat/completions');
  });
  it('runs Google through the Pi parser and the scoped bounded HTTP transport', async () => {
    let body = '';
    let tenant = '';
    let path = '';
    const url = await fixture((req, res) => {
      path = req.url ?? '';
      tenant = String(req.headers['x-tenant-key']);
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: {"candidates":[{"index":0,"content":{"parts":[{"text":"Google visible"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
        );
      });
    });
    const config = provider(url);
    config.pi = {
      id: 'google',
      api: 'google-generative-ai',
      models: [{ id: 'fixture-model' }],
      modelOverrides: {},
      headerCredentialRefs: {},
    };
    const result = await collect(
      new PiModelProvider(config, 'google-key', null, { 'x-tenant-key': 'tenant-vault-value' }),
    );
    expect(result).toContainEqual({ type: 'delta', text: 'Google visible' });
    expect(result).toContainEqual({ type: 'completed' });
    expect(path).toContain('fixture-model:streamGenerateContent');
    expect(tenant).toBe('tenant-vault-value');
    expect(body).toContain('reviewed context');
  });
  it('fails truncated streams and masks upstream errors without retries', async () => {
    let requests = 0;
    const url = await fixture((_req, res) => {
      requests++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"SECRET_BODY_CANARY"}}');
    });
    await expect(
      collect(new PiModelProvider(provider(url), 'SECRET_KEY_CANARY', null)),
    ).rejects.toThrow('Pi model provider request failed');
    expect(requests).toBe(1);
    const truncated = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(piSseText('openai-chat', 'partial'));
    });
    await expect(collect(new PiModelProvider(provider(truncated), 'key', null))).rejects.toThrow(
      'Pi model provider request failed',
    );
  });
  it('closes partial HTTP streams on consumer disposal', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const url = await fixture((_req, res) => {
      res.once('close', disconnected);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(piSseText('openai-chat', 'first'));
    });
    const stream = new PiModelProvider(provider(url), 'key', null)
      .stream(request())
      [Symbol.asyncIterator]();
    expect(await stream.next()).toMatchObject({ value: { type: 'delta', text: 'first' } });
    await stream.return?.();
    await closed;
  });
  it('times out and disconnects a stalled Pi response', async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const url = await fixture((_req, res) => {
      res.once('close', disconnected);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    });
    await expect(collect(new PiModelProvider(provider(url), 'key', null))).rejects.toThrow(
      'Model provider request was canceled or timed out',
    );
    await closed;
  });
  it.each(['wire', 'visible'] as const)(
    'bounds %s bytes and disconnects an oversized response',
    async (kind) => {
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const url = await fixture((_req, res) => {
        res.once('close', disconnected);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          kind === 'wire'
            ? `data: ${' '.repeat(4 * 1024 * 1024)}\n\n`
            : piSseText('openai-chat', 'a'.repeat(2 * 1024 * 1024 + 1)),
        );
      });
      await expect(collect(new PiModelProvider(provider(url), 'key', null))).rejects.toThrow(
        'Pi model provider request failed',
      );
      await closed;
    },
  );
  it('never executes or completes an unsolicited model tool call', async () => {
    const url = await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-fixture","type":"function","function":{"name":"terminal.exec","arguments":"{\\"command\\":\\"dangerous\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await expect(collect(new PiModelProvider(provider(url), 'key', null))).rejects.toThrow(
      'Pi model provider request failed',
    );
  });
});
