import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import type { StorageDomainFacility } from '@axterm/plugin-api';
import Storage from '../src/index.ts';

const facility: StorageDomainFacility = {
  open: async () => {
    throw new Error('fixture');
  },
  transaction: () => {
    throw new Error('fixture');
  },
};
it('revokes root-owned registries and forms when the hub provider unloads', async () => {
  const ctx = new Context();
  try {
    const owner = ctx.plugin(Storage);
    await owner;
    const storage = ctx.storage;
    const backends = storage.backend;
    backends.register('fixture', { close: async () => {} });
    storage.mount('domain', facility);
    await owner.dispose();
    expect(backends.names()).toEqual([]);
    expect(() => storage.domain).toThrow('not mounted');
    expect(() => backends.register('fixture', { close: async () => {} })).toThrow();
    expect(() => storage.mount('domain', facility)).toThrow();
  } finally {
    await ctx.fiber.dispose();
  }
});
it('owns each registration by its calling fiber and protects successor entries from old disposers', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    const caller = ctx.plugin({
      inject: ['storage'],
      apply(scope: Context) {
        scope.storage.backend.register('fixture', { close: async () => {} });
      },
    });
    await caller;
    expect(ctx.storage.backend.names()).toEqual(['fixture']);
    await caller.dispose();
    expect(ctx.storage.backend.names()).toEqual([]);
    const first = ctx.storage.backend.register('fixture', { close: async () => {} });
    await first();
    const replacement = { close: async () => {} };
    ctx.storage.backend.register('fixture', replacement);
    await first();
    expect(ctx.storage.backend.get('fixture')).toBe(replacement);
    expect(() => ctx.storage.backend.register('fixture', replacement)).toThrow(
      'already registered',
    );
  } finally {
    await ctx.fiber.dispose();
  }
});
it('releases caller and provider effects across repeated register/unregister cycles', async () => {
  const ctx = new Context();
  try {
    const provider = ctx.plugin(Storage);
    await provider;
    const rootEffects = ctx.fiber.getEffects().length;
    const providerEffects = provider.getEffects().length;
    for (let i = 0; i < 32; i++) {
      const release = ctx.storage.backend.register('fixture', { close: async () => {} });
      const unmount = ctx.storage.mount('domain', facility);
      await release();
      await release();
      await unmount();
      await unmount();
    }
    expect(ctx.fiber.getEffects()).toHaveLength(rootEffects);
    expect(provider.getEffects()).toHaveLength(providerEffects);
  } finally {
    await ctx.fiber.dispose();
  }
});
