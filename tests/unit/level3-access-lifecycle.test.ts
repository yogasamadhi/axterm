import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import Access from '../../packages/infra/remote-access/src/index.ts';
import type { RemoteAccessRequest, Principal } from '@axterm/plugin-api';

declare module '@axterm/plugin-api' {
  interface PrincipalMap {
    'access-lifetime-fixture': { readonly kind: 'access-lifetime-fixture' };
  }
}

it('drains root-owned policies on provider unload and rejects cached registration without retained effects', async () => {
  const ctx = new Context();
  try {
    const provider = ctx.plugin(Access);
    await provider;
    const access = ctx.remoteAccess;
    const effects = ctx.fiber.getEffects().length;
    const providerEffects = provider.getEffects().length;
    for (let index = 0; index < 32; index++) {
      const dispose = access.registerPolicy('access-lifetime-fixture', { bindings: () => [] });
      await dispose();
      await dispose();
    }
    await Promise.resolve();
    expect(ctx.fiber.getEffects()).toHaveLength(effects);
    expect(provider.getEffects()).toHaveLength(providerEffects);
    const request: RemoteAccessRequest<Principal> = {
      principal: { kind: 'access-lifetime-fixture' },
      action: 'desktop/health',
      resources: [],
    };
    access.registerPolicy('access-lifetime-fixture', { bindings: () => [] });
    expect(access.decide(request)).toEqual({ kind: 'allow' });
    await provider.dispose();
    expect(access.decide(request)).toEqual({ kind: 'deny', reason: 'no-allow' });
    expect(() =>
      access.registerPolicy('access-lifetime-fixture', { bindings: () => [] }),
    ).toThrow();
    // The SDK's one invocation accessor belongs to the root for all later Controllers.
    expect(ctx.fiber.getEffects().map((effect) => effect.label)).toEqual([
      'ctx.accessor("invocation")',
    ]);
    const replacement = ctx.plugin(Access);
    await replacement;
    await replacement.dispose();
    expect(ctx.fiber.getEffects().map((effect) => effect.label)).toEqual([
      'ctx.accessor("invocation")',
    ]);
  } finally {
    await ctx.fiber.dispose();
  }
});
