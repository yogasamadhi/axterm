import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopLifecycleState, RuntimeBaseline } from '@axterm/plugin-api/desktop';
import { desktopLifecycleStateSchema } from '@axterm/plugin-api/desktop';
import { nativeCapabilities } from '@axterm/infra-desktop-native';
import { ShellPowerLifecycle } from '../../apps/desktop/src/shell/power-lifecycle.ts';
import { DesktopLifecycle } from '../../packages/plugins/desktop/src/lifecycle.ts';
import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
import { DesktopResumePolicy } from '../../packages/plugins/desktop/src/client/resume-policy.ts';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const state = (
  revision = 0,
  lastEvent: DesktopLifecycleState['lastEvent'] = 'started',
): DesktopLifecycleState => ({
  revision,
  state: lastEvent === 'suspend' ? 'suspended' : 'active',
  lastEvent,
  changedAt: '2026-03-01T00:00:00.000Z',
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
it('owns exactly the two OS power listeners and removes them with strict cloned native snapshots', async () => {
  const power = new EventEmitter(),
    owner = new ShellPowerLifecycle(power);
  cleanups.push(() => owner.close());
  const signal = new AbortController().signal;
  expect(power.listenerCount('suspend')).toBe(1);
  expect(power.listenerCount('resume')).toBe(1);
  expect(await owner.state(signal)).toMatchObject({
    revision: 0,
    state: 'active',
    lastEvent: 'started',
  });
  power.emit('suspend');
  expect(await owner.state(signal)).toMatchObject({
    revision: 1,
    state: 'suspended',
    lastEvent: 'suspend',
  });
  power.emit('resume');
  const snapshot = await owner.state(signal);
  expect(snapshot).toMatchObject({ revision: 2, state: 'active', lastEvent: 'resume' });
  snapshot.revision = 900;
  expect((await owner.state(signal)).revision).toBe(2);
  expect(
    nativeCapabilities['desktop.lifecycle'].output.parse(await owner.state(signal)),
  ).toMatchObject({ revision: 2 });
  expect(() => desktopLifecycleStateSchema.parse({ ...state(), command: 'private' })).toThrow();
  expect(() =>
    desktopLifecycleStateSchema.parse({ ...state(), revision: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow();
  owner.close();
  owner.close();
  power.emit('resume');
  expect(power.listenerCount('suspend')).toBe(0);
  expect(power.listenerCount('resume')).toBe(0);
  await expect(owner.state(signal)).rejects.toThrow('CLOSED');
});
it('publishes only strictly newer native revisions with one poll and releases all wait resources', async () => {
  vi.useFakeTimers();
  let current = state();
  const read = vi.fn(async () => current),
    owner = new DesktopLifecycle({ state: read });
  cleanups.push(() => owner.close());
  await tick();
  const abort = new AbortController(),
    iterator = owner.watch(abort.signal);
  expect((await iterator.next()).value).toEqual(state());
  let emitted = false;
  const pending = iterator.next().then((result) => {
    emitted = true;
    return result;
  });
  current = state(0, 'resume');
  await vi.advanceTimersByTimeAsync(1000);
  expect(emitted).toBe(false);
  current = state(2, 'resume');
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).value).toEqual(current);
  expect(read).toHaveBeenCalledTimes(3);
  let late = false;
  const waiting = iterator.next().then((result) => {
    late = true;
    return result;
  });
  current = state(1, 'suspend');
  await vi.advanceTimersByTimeAsync(1000);
  expect(late).toBe(false);
  abort.abort();
  expect((await waiting).done).toBe(true);
  await iterator.return(undefined);
  await owner.close();
  expect(vi.getTimerCount()).toBe(0);
  const count = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(count);
});
it('joins a noncooperating native read on unload and never publishes or reschedules its late result', async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<DesktopLifecycleState>();
  let captured: AbortSignal | undefined;
  const read = vi.fn((signal: AbortSignal) => {
    captured = signal;
    return pending.promise;
  });
  const owner = new DesktopLifecycle({ state: read });
  cleanups.push(() => owner.close());
  const abort = new AbortController(),
    iterator = owner.watch(abort.signal);
  expect((await iterator.next()).value).toBeUndefined();
  const next = iterator.next();
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await tick();
  expect(captured?.aborted).toBe(true);
  expect(closed).toBe(false);
  expect((await next).done).toBe(true);
  pending.resolve(state(2, 'resume'));
  await closing;
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('refreshes only a newer resume within an observed generation and refuses initial replay, duplicate and retired states', () => {
  const policy = new DesktopResumePolicy();
  const generation = crypto.randomUUID();
  const baseline = (lifecycle: DesktopLifecycleState, g = generation): RuntimeBaseline => ({
    type: 'baseline',
    health: { status: 'ok' },
    version: { apiVersion: 'v1', appVersion: '0.10.0' },
    metadata: {
      runtimeId: crypto.randomUUID(),
      generation: g,
      startedAt: state().changedAt,
      pid: 1,
      mode: 'desktop',
      state: 'ready',
    },
    lifecycle,
  });
  expect(policy.accept(baseline(state(4, 'resume')))).toBe(false);
  expect(policy.accept(baseline(state(4, 'resume')))).toBe(false);
  expect(policy.accept(baseline(state(3, 'resume')))).toBe(false);
  expect(policy.accept(baseline(state(5, 'suspend')))).toBe(false);
  expect(policy.accept(baseline(state(6, 'resume')))).toBe(true);
  expect(policy.accept(baseline(state(6, 'resume')))).toBe(false);
  const next = crypto.randomUUID();
  expect(policy.accept(baseline(state(6, 'resume'), next))).toBe(false);
  expect(policy.accept(baseline(state(7, 'resume'), next))).toBe(true);
});
it('delivers native state through actual full Runtime Remote baselines and drains a suspended observer', async () => {
  vi.useFakeTimers();
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  let current = state();
  ctx.provide('runtimeIdentity', {
    runtimeId: crypto.randomUUID(),
    generation: crypto.randomUUID(),
    startedAt: state().changedAt,
    pid: 1,
    mode: 'desktop',
    appVersion: '0.10.0',
  });
  ctx.provide('nativeDesktopLifecycle', { state: async () => current });
  const owner = new DesktopRuntimeController(ctx);
  await tick();
  const iterator = owner.watchRuntime(new AbortController().signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: 'baseline', lifecycle: state() });
  const pending = iterator.next();
  current = state(2, 'resume');
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).value).toMatchObject({
    type: 'replace',
    lifecycle: current,
    metadata: { generation: ctx.runtimeIdentity.generation },
  });
  const waiting = iterator.next();
  await iterator.return?.();
  expect((await waiting).done).toBe(true);
  await ctx.fiber.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
