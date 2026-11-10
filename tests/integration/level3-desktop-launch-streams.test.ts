import { expect, it, vi } from 'vitest';
import { DesktopLaunchStreams } from '../../packages/plugins/desktop/src/launches.ts';
import { nativeCapabilities } from '@axterm/infra-desktop-native';
it('delivers each native event with stream backpressure and rejects arbitrary paths or dispatch fields', async () => {
  const windowId = crypto.randomUUID(),
    event = { id: crypto.randomUUID(), source: 'local://terminal' };
  const next = vi.fn(async () => event),
    owner = new DesktopLaunchStreams(() => ({ next }));
  const stream = owner.watch(windowId, new AbortController().signal)[Symbol.asyncIterator]();
  expect(await stream.next()).toEqual({ done: false, value: event });
  expect(next).toHaveBeenCalledExactlyOnceWith(windowId, expect.any(AbortSignal));
  expect(
    nativeCapabilities['desktopLaunch.next'].input.safeParse({ windowId, path: '/tmp/forbidden' })
      .success,
  ).toBe(false);
  expect(
    nativeCapabilities['desktopLaunch.next'].input.safeParse({ windowId, method: 'createTerminal' })
      .success,
  ).toBe(false);
  await stream.return?.();
  expect(owner.resourceCount()).toBe(0);
  await owner.close();
});
it('joins a real pending native acquisition after abort instead of reporting an early drain', async () => {
  const pending = Promise.withResolvers<null>(),
    next = vi.fn((_windowId: string, _signal: AbortSignal) => pending.promise),
    owner = new DesktopLaunchStreams(() => ({ next }));
  const stream = owner
    .watch(crypto.randomUUID(), new AbortController().signal)
    [Symbol.asyncIterator]();
  const outcome = Promise.allSettled([stream.next()]);
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  let stopped = false;
  const closing = owner.close().then(() => {
    stopped = true;
  });
  expect(next.mock.calls[0]![1].aborted).toBe(true);
  expect(stopped).toBe(false);
  pending.resolve(null);
  await closing;
  expect((await outcome)[0]!.status).toBe('rejected');
  expect(owner.resourceCount()).toBe(0);
});
it('bounds native streams and refuses missing native input without installing an alternate transport', async () => {
  const missing = new DesktopLaunchStreams(() => undefined);
  expect(() => missing.watch(crypto.randomUUID(), new AbortController().signal)).toThrow(
    'UNAVAILABLE',
  );
  await missing.close();
  const owner = new DesktopLaunchStreams(() => ({ next: async () => null }));
  for (let i = 0; i < 8; i++) owner.watch(crypto.randomUUID(), new AbortController().signal);
  expect(() => owner.watch(crypto.randomUUID(), new AbortController().signal)).toThrow('CAPACITY');
  await owner.close();
  expect(owner.resourceCount()).toBe(0);
});

it('releases unread stream reservations on return and on caller cancellation', async () => {
  const next = vi.fn(async () => null),
    owner = new DesktopLaunchStreams(() => ({ next }));
  for (let i = 0; i < 16; i++) {
    const controller = new AbortController(),
      stream = owner.watch(crypto.randomUUID(), controller.signal)[Symbol.asyncIterator]();
    if (i % 2) controller.abort();
    else await stream.return?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.resourceCount()).toBe(0);
  }
  expect(next).not.toHaveBeenCalled();
  await owner.close();
});
it('return aborts a pending native acquisition and waits for its actual settlement', async () => {
  const gate = Promise.withResolvers<null>(),
    next = vi.fn((_id: string, _signal: AbortSignal) => gate.promise),
    owner = new DesktopLaunchStreams(() => ({ next }));
  const stream = owner
      .watch(crypto.randomUUID(), new AbortController().signal)
      [Symbol.asyncIterator](),
    pending = Promise.allSettled([stream.next()]);
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  let returned = false;
  const closing = stream.return!().then(() => {
    returned = true;
  });
  expect(next.mock.calls[0]![1].aborted).toBe(true);
  expect(owner.resourceCount()).toBe(1);
  expect(returned).toBe(false);
  gate.resolve(null);
  await closing;
  expect((await pending)[0]!.status).toBe('rejected');
  expect(owner.resourceCount()).toBe(0);
  await owner.close();
});
