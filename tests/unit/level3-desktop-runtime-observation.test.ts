import { Context } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
it('bounds unread runtime observations, reclaims them on return and cancels a suspended baseline iterator', async () => {
  const ctx = new Context();
  ctx.provide('runtimeIdentity', {
    runtimeId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  const owner = new DesktopRuntimeController(ctx);
  try {
    const streams = Array.from({ length: 64 }, () =>
      owner.watchRuntime(new AbortController().signal)[Symbol.asyncIterator](),
    );
    expect(() => owner.watchRuntime(new AbortController().signal)).toThrow('capacity');
    await Promise.all(streams.map((stream) => stream.return?.()));
    const source = owner.watchRuntime(new AbortController().signal)[Symbol.asyncIterator]();
    expect((await source.next()).value).toMatchObject({ type: 'baseline' });
    const pending = source.next();
    await source.return?.();
    expect((await pending).done).toBe(true);
    const controller = new AbortController();
    owner.watchRuntime(controller.signal);
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    await ctx.fiber.dispose();
  }
});
