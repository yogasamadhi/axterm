import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { aiProviderSchema, aiProviderInputSchema } from '@axterm/plugin-api/ai';
import Engines from '../../packages/infra/engines/src/index.ts';
import { AiModels, piBinding } from '../../packages/plugins/ai/src/adapters/models.ts';

function provider(engineId: string) {
  return aiProviderSchema.parse({
    id: randomUUID(),
    engineId,
    name: 'Selected Engine',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  });
}
it('requires real Pi transport while accepting other Engines without invented URLs or credentials', () => {
  const external = provider('external');
  expect(external.baseUrl).toBeUndefined();
  expect(external.credentialRef).toBeUndefined();
  expect(() => provider('pi')).toThrow();
  expect(() =>
    aiProviderInputSchema.parse({ name: 'Existing default Pi', enabled: true }),
  ).toThrow();
  expect(
    aiProviderInputSchema.parse({ name: 'Selected external', enabled: true, engineId: 'external' })
      .engineId,
  ).toBe('external');
  expect(() => piBinding(external, 'model')).toThrow('UNSUPPORTED');
});
it('selects only the configured Engine, keeps discovery explicitly unsupported, and drains actual runs on owner close', async () => {
  const ctx = new Context();
  await ctx.plugin(Engines);
  let opens = 0;
  let closes = 0;
  let sawCancellation = false;
  ctx.engines.register('external', {
    label: 'External fixture',
    capabilities: { cancellation: true, tools: false, resume: false },
    openSession: async () => {
      opens++;
      return {
        run: async (input, context) => {
          expect(input.model).toBe('selected-model');
          let off = () => {};
          const aborted = new Promise<void>((resolve) => {
            const abort = () => {
              sawCancellation = true;
              resolve();
            };
            context.signal.addEventListener('abort', abort, { once: true });
            off = () => context.signal.removeEventListener('abort', abort);
            if (context.signal.aborted) abort();
          });
          try {
            await context.emit({ type: 'delta', text: 'Selected external output' });
            await aborted;
          } finally {
            off();
          }
        },
        close: async () => {
          closes++;
        },
      };
    },
  });
  const models = new AiModels(ctx);
  try {
    const selected = await models.create(provider('external'));
    await expect(selected.listModels()).rejects.toThrow('UNSUPPORTED');
    expect(opens).toBe(0);
    const iterator = selected
      .stream({
        model: 'selected-model',
        system: '',
        prompt: 'Visible request',
        context: '',
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'delta', text: 'Selected external output' },
    });
    const closing = models.close();
    await iterator.return?.();
    await closing;
    expect(sawCancellation).toBe(true);
    expect(closes).toBe(1);
    expect(models.resourceCount()).toBe(0);
    expect(opens).toBe(1);
  } finally {
    await models.close();
    await ctx.fiber.dispose();
  }
});
it('does not fall back when the selected external Engine is missing', async () => {
  const ctx = new Context();
  await ctx.plugin(Engines);
  const models = new AiModels(ctx);
  try {
    const selected = await models.create(provider('missing'));
    const iterator = selected
      .stream({
        model: 'selected-model',
        system: '',
        prompt: '',
        context: '',
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'AI_ENGINE_MISSING' });
    await vi.waitFor(() => expect(models.resourceCount()).toBe(0));
    expect(ctx.engines.list()).toEqual([]);
  } finally {
    await models.close();
    await ctx.fiber.dispose();
  }
});
