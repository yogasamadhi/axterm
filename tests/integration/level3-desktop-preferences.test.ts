import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { NativeDesktopWindows, NativeDesktopWindowState } from '@axterm/plugin-api/desktop';
import { DesktopPreferencesStore } from '../../packages/plugins/desktop/src/preferences-store.ts';
import { DesktopPreferences } from '../../packages/plugins/desktop/src/preferences.ts';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function boot(native?: NativeDesktopWindows) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.desktop),
    store = new DesktopPreferencesStore(domain),
    generation = randomUUID(),
    owner = new DesktopPreferences(store, generation, native);
  ctx.effect(() => () => owner.close());
  return { ctx, domain, store, owner, generation };
}
const state = (appliedVersion: number): NativeDesktopWindowState => ({
  appliedVersion,
  globalHotkeyRegistered: true,
  requiresRestart: false,
  bounds: null,
});
it('stores reviewed versions, durable outbox and exact receipts without replaying an old preference over newer facts', async () => {
  const { store, domain, generation } = await boot();
  expect(store.read().version).toBe(0);
  const key = randomUUID(),
    patch = { opacity: 0.8, rememberWindowSize: true };
  const first = store.update(key, patch, 0, generation);
  expect(first.version).toBe(1);
  expect(domain.events(0).map((event) => event.type)).toContain('desktop/preferences-changed');
  store.update(randomUUID(), { zoomFactor: 1.5 }, 1, generation);
  expect(store.update(key, patch, 0, generation)).toEqual(first);
  expect(store.read()).toMatchObject({
    version: 2,
    preferences: { opacity: 0.8, zoomFactor: 1.5, rememberWindowSize: true },
  });
  expect(() => store.update(key, { opacity: 0.6 }, 0, generation)).toThrow();
  expect(() => store.update(randomUUID(), { opacity: 0.6 }, 0, generation)).toThrow('changed');
});
it('publishes one baseline then complete replacements, fences generations and releases never-started observers', async () => {
  const { owner, generation } = await boot();
  await owner.initialize();
  const iterator = owner.watch(new AbortController().signal);
  expect((await iterator.next()).value).toMatchObject({
    type: 'baseline',
    record: { version: 0 },
    application: 'unavailable',
  });
  await owner.update(randomUUID(), { opacity: 0.7 }, 0, generation);
  expect((await iterator.next()).value).toMatchObject({
    type: 'replace',
    record: { version: 1, preferences: { opacity: 0.7 } },
  });
  await iterator.return?.();
  const observers = Array.from({ length: 64 }, () => owner.watch(new AbortController().signal));
  expect(() => owner.watch(new AbortController().signal)).toThrow();
  await Promise.all(observers.map((observer) => observer.return?.()));
  const another = owner.watch(new AbortController().signal);
  await another.return?.();
  await expect(owner.update(randomUUID(), { opacity: 0.9 }, 1, randomUUID())).rejects.toThrow();
});
it('keeps accepted facts visible on native failure and reconciles the newest fact on explicit retry or receipt replay', async () => {
  const configure = vi
    .fn<NativeDesktopWindows['configure']>()
    .mockImplementation(async (record) => state(record.version));
  const native = { configure, state: vi.fn(async () => state(0)) };
  const { owner, store, generation } = await boot(native);
  await owner.initialize();
  configure.mockRejectedValueOnce(Error('native failed'));
  const key = randomUUID(),
    patch = { opacity: 0.9 };
  await owner.update(key, patch, 0, generation);
  expect(owner.snapshot()).toMatchObject({
    record: { version: 1, preferences: { opacity: 0.9 } },
    application: 'failed',
  });
  store.update(randomUUID(), { zoomFactor: 1.7 }, 1, generation);
  await owner.retry(generation);
  expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({
    version: 2,
    preferences: { zoomFactor: 1.7 },
  });
  await owner.update(key, patch, 0, generation);
  expect(configure.mock.calls.at(-1)?.[0].version).toBe(2);
  expect(owner.snapshot().application).toBe('ready');
});
it('joins actual startup/native work before closing the storage owner', async () => {
  const release = Promise.withResolvers<NativeDesktopWindowState>();
  const configure = vi.fn(() => release.promise);
  const { owner } = await boot({ configure, state: async () => state(0) });
  const starting = owner.initialize();
  await vi.waitFor(() => expect(configure).toHaveBeenCalledOnce());
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve(state(0));
  await starting;
  await closing;
  expect(closed).toBe(true);
  expect(() => owner.snapshot()).toThrow();
});
it('flushes the last normal bounds before releasing storage even when the independent hotkey is unavailable', async () => {
  let version = 0;
  const bounds = { x: 40, y: 50, width: 1180, height: 780 };
  const read = vi.fn(async () => ({ ...state(version), globalHotkeyRegistered: false, bounds }));
  const { owner, store, generation, domain } = await boot({
    configure: async (record) => {
      version = record.version;
      return { ...state(version), globalHotkeyRegistered: false };
    },
    state: read,
  });
  await owner.initialize();
  await owner.update(randomUUID(), { rememberWindowSize: true }, 0, generation);
  expect(owner.snapshot().application).toBe('failed');
  await owner.close();
  expect(read).toHaveBeenCalledOnce();
  expect(store.read()).toMatchObject({ version: 2, preferences: { bounds } });
  expect(
    domain.events(0).filter((event) => event.type === 'desktop/preferences-changed'),
  ).toHaveLength(2);
  await expect(owner.update(randomUUID(), { opacity: 0.9 }, 2, generation)).rejects.toThrow();
});
it('does not replace normal geometry with maximized, stale or unavailable final observations', async () => {
  for (const observed of [
    state(1),
    { ...state(0), bounds: { x: 1, y: 2, width: 1000, height: 700 } },
    null,
  ]) {
    const { owner, store, generation } = await boot({
      configure: async (record) => state(record.version),
      state: async () => {
        if (!observed) throw Error('NATIVE_CLOSED');
        return observed;
      },
    });
    await owner.initialize();
    const bounds = { x: 40, y: 50, width: 1180, height: 780 };
    await owner.update(randomUUID(), { rememberWindowSize: true, bounds }, 0, generation);
    await owner.close();
    expect(store.read()).toMatchObject({ version: 1, preferences: { bounds } });
  }
});
it('joins a final native observation after its bounded cancellation instead of releasing storage early', async () => {
  const release = Promise.withResolvers<NativeDesktopWindowState>();
  let requested: AbortSignal | undefined;
  const { owner, store, generation } = await boot({
    configure: async (record) => state(record.version),
    state: async (signal) => {
      requested = signal;
      return release.promise;
    },
  });
  await owner.initialize();
  await owner.update(randomUUID(), { rememberWindowSize: true }, 0, generation);
  vi.useFakeTimers();
  try {
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(requested?.aborted).toBe(true);
    expect(closed).toBe(false);
    expect(store.read().version).toBe(1);
    release.resolve(state(1));
    await closing;
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
