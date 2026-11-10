import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { DesktopUpdaterPort, UpdaterStatus } from '@axterm/plugin-api/desktop';
import { ShellUpdater } from '../../packages/infra/desktop-native/src/updater.ts';
import { nativeCapabilities } from '../../packages/infra/desktop-native/src/protocol.ts';
import { DesktopUpdates } from '../../packages/plugins/desktop/src/updater.ts';
import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
import { DesktopUpdateCommands } from '../../packages/plugins/desktop/src/client/updater-commands.ts';
const signal = () => new AbortController().signal;
it('keeps the native updater table closed and rejects paths, arbitrary actions and malformed receipts', () => {
  const pair = nativeCapabilities['updater.perform'];
  expect(pair.input.safeParse({ key: randomUUID(), action: 'check' }).success).toBe(true);
  for (const input of [
    { key: 'not-id', action: 'check' },
    { key: randomUUID(), action: 'exec' },
    { key: randomUUID(), action: 'install', path: '/tmp/untrusted' },
  ])
    expect(pair.input.safeParse(input).success).toBe(false);
  expect(pair.output.safeParse({ state: 'ready', path: '/secret' }).success).toBe(false);
  expect(pair.output.safeParse({ state: 'error', errorCode: '/secret/password' }).success).toBe(
    false,
  );
});
it('deduplicates exact update commands and joins actual native work before drain/close', async () => {
  const release = Promise.withResolvers<UpdaterStatus>();
  const perform = vi.fn<DesktopUpdaterPort['perform']>(() => release.promise);
  const close = vi.fn(async () => {
    await release.promise;
  });
  const owner = new ShellUpdater({ status: () => ({ state: 'checking' }), perform, close });
  const h = owner.handlers(),
    key = randomUUID();
  const a = h['updater.perform']({ key, action: 'check' }, signal());
  const b = h['updater.perform']({ key, action: 'check' }, signal());
  expect(() => h['updater.perform']({ key, action: 'install' }, signal())).toThrow('CONFLICT');
  await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
  let drained = false,
    stopped = false;
  const drain = Promise.resolve(h['updater.drain']({ key }, signal())).then(() => {
    drained = true;
  });
  const closing = owner.close().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(stopped).toBe(false);
  release.resolve({ state: 'available', availableVersion: '1.0.1' });
  await Promise.all([a, b, drain, closing]);
  expect(perform).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(() => h['updater.status']({}, signal())).toThrow('CLOSED');
});
it('requests cancellation without releasing an undrained native operation', async () => {
  const release = Promise.withResolvers<UpdaterStatus>();
  const perform = vi.fn<DesktopUpdaterPort['perform']>(async (action) =>
    action === 'cancel' ? { state: 'idle' } : release.promise,
  );
  const owner = new ShellUpdater({
    status: () => ({ state: 'checking' }),
    perform,
    close: async () => {
      await release.promise;
    },
  });
  const h = owner.handlers(),
    abort = new AbortController(),
    key = randomUUID();
  const task = h['updater.perform']({ key, action: 'check' }, abort.signal);
  await vi.waitFor(() => expect(perform).toHaveBeenCalledWith('check'));
  abort.abort();
  await vi.waitFor(() => expect(perform).toHaveBeenCalledWith('cancel'));
  let drained = false;
  const drain = Promise.resolve(h['updater.drain']({ key }, signal())).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release.resolve({ state: 'idle' });
  await task;
  await drain;
  await owner.close();
});
it('retains Shell ownership after a lost native acknowledgement and reports failed drain', async () => {
  const release = Promise.withResolvers<void>();
  const native = {
    status: vi.fn(async (): Promise<UpdaterStatus> => ({ state: 'idle' })),
    perform: vi.fn(async () => {
      throw { code: 'CANCELLED' };
    }),
    drain: vi.fn(() => release.promise),
  };
  const owner = new DesktopUpdates(() => native),
    key = randomUUID();
  const task = owner.perform(key, 'check', signal());
  const outcome = expect(task).rejects.toMatchObject({ details: { reason: 'uncertain' } });
  await vi.waitFor(() => expect(native.drain).toHaveBeenCalledWith(key));
  let stopped = false;
  const closing = owner.close().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve();
  await outcome;
  await closing;
  const failed = new DesktopUpdates(() => ({
    ...native,
    drain: async () => {
      throw Error('gone');
    },
  }));
  await expect(failed.perform(randomUUID(), 'install', signal())).rejects.toMatchObject({
    details: { reason: 'uncertain' },
  });
  await expect(failed.close()).rejects.toMatchObject({ details: { reason: 'uncertain' } });
});
it('fences action generations and reclaims unread or suspended full-baseline observations', async () => {
  const ctx = new Context(),
    generation = randomUUID();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'desktop',
    appVersion: '0.10.0',
  });
  const perform = vi.fn(async (): Promise<UpdaterStatus> => ({ state: 'idle' }));
  ctx.provide('nativeDesktopUpdater', {
    status: async () => ({ state: 'idle' }),
    perform,
    drain: async () => {},
  });
  const owner = new DesktopRuntimeController(ctx);
  try {
    expect(() =>
      owner.performUpdaterAction(randomUUID(), randomUUID(), 'install', signal()),
    ).toThrow('retired');
    expect(perform).not.toHaveBeenCalled();
    const streams = Array.from({ length: 16 }, () =>
      owner.watchUpdater(signal())[Symbol.asyncIterator](),
    );
    expect(() => owner.watchUpdater(signal())).toThrow('capacity');
    await Promise.all(streams.map((s) => s.return?.()));
    const s = owner.watchUpdater(signal())[Symbol.asyncIterator]();
    expect((await s.next()).value).toEqual({
      type: 'baseline',
      generation,
      status: { state: 'idle' },
    });
    const waiting = s.next();
    await s.return?.();
    expect((await waiting).done).toBe(true);
  } finally {
    await ctx.fiber.dispose();
  }
});
it('retries the original UI command key and never replays it into a new generation', async () => {
  let generation = randomUUID();
  const send = vi
    .fn<ConstructorParameters<typeof DesktopUpdateCommands>[1]>()
    .mockRejectedValueOnce(Error('lost'))
    .mockResolvedValueOnce({ state: 'ready' });
  const commands = new DesktopUpdateCommands(() => generation, send);
  await expect(commands.perform('install')).rejects.toThrow('UNCERTAIN');
  expect(commands.getSnapshot()).toEqual({ busy: false, uncertain: true });
  expect(() => commands.perform('install')).toThrow('BUSY');
  const first = send.mock.calls[0]!;
  await commands.retry();
  expect(send.mock.calls[1]!.slice(0, 3)).toEqual(first.slice(0, 3));
  send.mockRejectedValueOnce(Error('lost again'));
  await expect(commands.perform('check')).rejects.toThrow('UNCERTAIN');
  generation = randomUUID();
  await expect(commands.retry()).rejects.toThrow('FAILED');
  expect(send).toHaveBeenCalledTimes(3);
  await commands.close();
});
it('allows one explicit cancellation while the original UI action is running and drains both', async () => {
  const release = Promise.withResolvers<void>(),
    generation = randomUUID();
  const send = vi.fn<ConstructorParameters<typeof DesktopUpdateCommands>[1]>(
    async (_g, _k, action) => {
      if (action === 'cancel') release.resolve();
      await release.promise;
    },
  );
  const commands = new DesktopUpdateCommands(() => generation, send);
  const first = commands.perform('download');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  await commands.perform('cancel');
  await first;
  expect(send.mock.calls.map((x) => x[2])).toEqual(['download', 'cancel']);
  expect(send.mock.calls[0]![1]).not.toBe(send.mock.calls[1]![1]);
  await commands.close();
});
