import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
it('represents absent desktop capabilities with stable unavailable or disabled results and no private details', async () => {
  const ctx = new Context(),
    generation = randomUUID();
  ctx.provide('runtimeIdentity', {
    generation,
    runtimeId: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  const owner = new DesktopRuntimeController(ctx);
  const unavailable = { code: 'desktop/failure', details: { reason: 'unavailable' } };
  try {
    expect(() => owner.getWindowPreferences()).toThrow(expect.objectContaining(unavailable));
    await expect(
      owner.updateWindowPreferences(randomUUID(), {}, 0, generation),
    ).rejects.toMatchObject(unavailable);
    await expect(owner.getUpdaterStatus(new AbortController().signal)).resolves.toEqual({
      state: 'disabled',
    });
    await expect(
      owner.performUpdaterAction(generation, randomUUID(), 'check', new AbortController().signal),
    ).rejects.toMatchObject(unavailable);
    expect(owner.getVersion()).toEqual({ apiVersion: 'v1', appVersion: '0.10.0' });
  } finally {
    await ctx.fiber.dispose();
  }
});
