import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { aiProviderSchema, type AiProvider } from '@axterm/plugin-api/ai';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import Engines from '../../packages/infra/engines/src/index.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import { AiModels, piBinding } from '../../packages/plugins/ai/src/adapters/models.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const listener = createServer(handler);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  cleanups.push(async () => {
    const done = once(listener, 'close');
    listener.close();
    listener.closeAllConnections();
    await done;
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture');
  return `http://127.0.0.1:${address.port}/v1`;
}
function provider(
  baseUrl: string,
  patch: Partial<AiProvider> = {},
): AiProvider & { baseUrl: string; credentialRef: string } {
  const value = aiProviderSchema.parse({
    id: randomUUID(),
    name: 'Saved provider',
    baseUrl,
    credentialRef: 'cred_' + randomUUID(),
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...patch,
  });
  if (!value.baseUrl || !value.credentialRef) throw new Error('Pi fixture transport is missing');
  return { ...value, baseUrl: value.baseUrl, credentialRef: value.credentialRef };
}
async function boot(value: AiProvider) {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  if (!value.credentialRef) throw new Error('Pi fixture requires its real credential reference');
  await ctx.plugin(MemoryCredentials, {
    [encodeOpaqueCredentialRef(value.credentialRef)]: 'FACTORY_PRIVATE_KEY',
  });
  await ctx.plugin(Engines);
  ctx.engines.register(
    'pi',
    new PiEngineProvider(ctx, piEngineConfigSchema.parse({ providers: {} })),
  );
  const models = new AiModels(ctx);
  cleanups.push(() => models.close());
  return { ctx, models };
}
it('captures provider facts as reference-only bindings without changing application or proxy references', () => {
  const value = provider('http://127.0.0.1:1/v1', {
    proxy: {
      url: 'socks5h://127.0.0.1:1080',
      username: 'user',
      credentialRef: 'original-proxy-ref',
    },
  });
  const before = structuredClone(value);
  const binding = piBinding(value, 'chosen');
  const data = binding.configuration as Record<string, unknown>;
  const configured = data.provider as Record<string, unknown>;
  expect(configured.credentialRef).toBe(encodeOpaqueCredentialRef(value.credentialRef));
  expect(configured.proxy).toEqual(value.proxy);
  expect(configured.models).toEqual([{ id: 'chosen' }]);
  expect(value).toEqual(before);
  expect(JSON.stringify(binding)).not.toContain('FACTORY_PRIVATE_KEY');
});
for (const shape of ['array', 'data', 'models'] as const)
  it(`discovers legacy ${shape} metadata using the saved Vault reference and exact GET endpoint`, async () => {
    let path = '';
    let method = '';
    let key = '';
    const url = await server((req, res) => {
      path = req.url ?? '';
      method = req.method ?? '';
      key = String(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      const values = ['one', { id: 'two' }, { name: 'one' }, { model: 'three' }, ''];
      res.end(JSON.stringify(shape === 'array' ? values : { [shape]: values }));
    });
    const saved = provider(url);
    const { models } = await boot(saved);
    const adapter = await models.create(saved);
    expect(await adapter.listModels()).toEqual(['one', 'two', 'three']);
    expect({ path, method, key }).toEqual({
      path: '/v1/models',
      method: 'GET',
      key: 'Bearer FACTORY_PRIVATE_KEY',
    });
    expect(models.resourceCount()).toBe(0);
  });
it('keeps model metadata bounded and refuses redirect fallback without reaching the alternate origin', async () => {
  let foreignRequests = 0;
  const foreign = await server((req, res) => {
    foreignRequests++;
    req.resume();
    res.end('[]');
  });
  const redirect = await server((_req, res) => {
    res.writeHead(302, { location: foreign });
    res.end();
  });
  const saved = provider(redirect);
  const { models } = await boot(saved);
  await expect((await models.create(saved)).listModels()).rejects.toThrow('PROVIDER_FAILED');
  expect(foreignRequests).toBe(0);
  const huge = await server((_req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(2 * 1024 * 1024 + 1));
  });
  await expect((await models.create({ ...saved, baseUrl: huge })).listModels()).rejects.toThrow(
    'CAPACITY',
  );
  expect(models.resourceCount()).toBe(0);
});
it('probes Pi configurations through the actual selected Engine without exposing probe text as a visible message', async () => {
  let requests = 0;
  const url = await server((req, res) => {
    requests++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        piSseStart('openai-chat') +
          piSseText('openai-chat', 'PRIVATE_PROBE_TEXT') +
          piSseEnd('openai-chat'),
      );
    });
  });
  const saved = provider(url, {
    pi: {
      id: 'custom',
      api: 'openai-completions',
      models: [{ id: 'actual-model' }],
      modelOverrides: {},
      headerCredentialRefs: {},
    },
  });
  const { models } = await boot(saved);
  const adapter = await models.create(saved, 'actual-model');
  expect(await adapter.listModels()).toEqual(['actual-model']);
  expect(requests).toBe(1);
  expect(models.resourceCount()).toBe(0);
  expect(models.skills().length).toBeGreaterThan(0);
  expect(models.skillInstructions('diagnose')).toContain('<skill');
});
it('executes a legacy application model through an immutable Engine binding and drains a paused consumer on owner close', async () => {
  let responseClosed = false;
  const url = await server((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(piSseStart('openai-chat') + piSseText('openai-chat', 'visible'));
      res.once('close', () => {
        responseClosed = true;
      });
    });
  });
  const saved = provider(url);
  const { models } = await boot(saved);
  const adapter = await models.create(saved);
  const events = adapter
    .stream({
      model: 'manual-model',
      system: 'system',
      prompt: 'visible input',
      context: 'reviewed',
      signal: new AbortController().signal,
    })
    [Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual({ type: 'delta', text: 'visible' });
  expect(models.resourceCount()).toBeGreaterThan(0);
  await models.close();
  await vi.waitFor(() => expect(responseClosed).toBe(true));
  expect(models.resourceCount()).toBe(0);
  await events.return?.();
  await expect(models.create(saved)).rejects.toThrow('CLOSED');
});
it('cancels metadata preparation during shutdown and performs no HTTP request after closure', async () => {
  let requests = 0;
  const url = await server((_req, res) => {
    requests++;
    res.writeHead(200);
    res.write('[');
  });
  const saved = provider(url);
  const { models } = await boot(saved);
  const adapter = await models.create(saved);
  const query = adapter.listModels();
  void query.catch(() => {});
  await vi.waitFor(() => expect(requests).toBe(1));
  await models.close();
  await expect(query).rejects.toThrow('CANCELLED');
  expect(models.resourceCount()).toBe(0);
  expect(() => adapter.listModels()).toThrow('CLOSED');
  expect(requests).toBe(1);
});

it('retains a failed actual Engine close and refuses to report the model owner drained', async () => {
  const ctx = new Context();
  await ctx.plugin(Engines);
  ctx.engines.register('external', {
    label: 'External',
    capabilities: { cancellation: true, tools: false, resume: false },
    openSession: async () => ({
      run: async (_input, context) => {
        await context.emit({ type: 'delta', text: 'held' });
      },
      close: async () => {
        throw new Error('controlled close failure');
      },
    }),
  });
  const models = new AiModels(ctx);
  const saved = provider('http://127.0.0.1:1', { engineId: 'external' });
  const adapter = await models.create(saved);
  const iterator = adapter
    .stream({
      model: 'actual',
      system: '',
      prompt: '',
      context: '',
      signal: new AbortController().signal,
    })
    [Symbol.asyncIterator]();
  try {
    await iterator.next();
    await expect(models.close()).rejects.toThrow('DRAIN_FAILED');
    expect(models.resourceCount()).toBeGreaterThan(0);
    await expect(models.close()).rejects.toThrow('DRAIN_FAILED');
    await expect(iterator.return?.()).rejects.toMatchObject({ code: 'AI_ENGINE_DRAIN_FAILED' });
  } finally {
    // This fixture has no native handle; its deliberate failed close remains an owned failure.
    await models.close().catch(() => {});
    await ctx.fiber.dispose().catch(() => {});
  }
});
