import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { SlotRegistry } from '../src/client/registry.ts';

it('revokes caller-owned contributions and cached mutation faces when the renderer provider unloads', async () => {
  const ctx = new Context();
  try {
    const provider = ctx.plugin(SlotRegistry);
    await provider;
    const cached = ctx.slots;
    const observed = vi.fn();
    cached.subscribe('root', observed);
    cached.register({ name: 'root' }, () => null);
    expect(cached.entries('root')).toHaveLength(1);
    await provider.dispose();
    expect(cached.entries('root')).toHaveLength(0);
    observed.mockClear();
    expect(() => cached.register({ name: 'root' }, () => null)).toThrow();
    expect(() => cached.subscribe('root', observed)).toThrow();
    expect(observed).not.toHaveBeenCalled();
    const replacement = ctx.plugin(SlotRegistry);
    await replacement;
    ctx.slots.register({ name: 'root' }, () => null);
    expect(ctx.slots.entries('root')).toHaveLength(1);
    expect(cached.entries('root')).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
  }
});
