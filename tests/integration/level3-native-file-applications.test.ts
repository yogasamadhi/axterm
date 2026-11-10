import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, writeFile, rm, symlink, link, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ShellFileGrantCapabilities,
  NativeError,
  nativeCapabilities,
} from '@axterm/infra-desktop-native';
import DesktopFileApplications from '../../packages/infra/desktop-native/src/applications.ts';
import type { NativeClient } from '../../packages/infra/desktop-native/src/bridge.ts';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-native-apps-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const open = vi.fn(async (_path: string) => {}),
    reveal = vi.fn(async (_path: string) => {});
  const cap = new ShellFileGrantCapabilities(crypto.randomUUID(), undefined, undefined, {
    open,
    reveal,
  });
  cleanup.push(() => cap.close());
  const handlers = cap.handlers();
  const signal = () => new AbortController().signal;
  return { home, cap, handlers, open, reveal, signal };
}
it('opens and reveals only verified local grants and never accepts raw native paths or executables', async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'note.txt'), 'owned');
  const grant = await f.cap.registry.createTrustedPath(f.home, 'directory', ['read']);
  expect(
    await f.handlers['fileGrant.open'](
      { key: crypto.randomUUID(), grantId: grant.grantId, path: 'note.txt' },
      f.signal(),
    ),
  ).toBe(true);
  expect(
    await f.handlers['fileGrant.reveal'](
      { key: crypto.randomUUID(), grantId: grant.grantId, path: 'note.txt' },
      f.signal(),
    ),
  ).toBe(true);
  const canonical = await realpath(join(f.home, 'note.txt'));
  expect(f.open).toHaveBeenCalledWith(canonical);
  expect(f.reveal).toHaveBeenCalledWith(canonical);
  expect(
    nativeCapabilities['fileGrant.open'].input.safeParse({
      key: crypto.randomUUID(),
      grantId: grant.grantId,
      path: '../outside',
    }).success,
  ).toBe(false);
  expect(
    nativeCapabilities['fileGrant.open'].input.safeParse({
      key: crypto.randomUUID(),
      grantId: grant.grantId,
      path: canonical,
    }).success,
  ).toBe(false);
  expect(
    nativeCapabilities['fileGrant.open'].input.safeParse({
      key: crypto.randomUUID(),
      grantId: grant.grantId,
      path: 'note.txt',
      editorExecutable: '/bin/sh',
    }).success,
  ).toBe(false);
  expect(f.cap.resourceCount()).toBe(0);
});
it('rejects symbolic/hard links, revoked authority and a selected file whose identity changed', async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'a.txt'), 'owned');
  const selected = await f.cap.registry.createTrustedPath(join(f.home, 'a.txt'), 'file', ['read']);
  await rename(join(f.home, 'a.txt'), join(f.home, 'before.txt'));
  await writeFile(join(f.home, 'a.txt'), 'replacement');
  await expect(
    f.handlers['fileGrant.open'](
      { key: crypto.randomUUID(), grantId: selected.grantId, path: '' },
      f.signal(),
    ),
  ).rejects.toMatchObject({ code: 'STALE' });
  const directory = await f.cap.registry.createTrustedPath(f.home, 'directory', ['read']);
  await symlink(join(f.home, 'a.txt'), join(f.home, 'soft.txt'));
  await link(join(f.home, 'a.txt'), join(f.home, 'hard.txt'));
  for (const path of ['soft.txt', 'hard.txt'])
    await expect(
      f.handlers['fileGrant.open'](
        { key: crypto.randomUUID(), grantId: directory.grantId, path },
        f.signal(),
      ),
    ).rejects.toBeInstanceOf(NativeError);
  f.cap.registry.revoke(directory.grantId);
  await expect(
    f.handlers['fileGrant.reveal'](
      { key: crypto.randomUUID(), grantId: directory.grantId, path: 'before.txt' },
      f.signal(),
    ),
  ).rejects.toBeInstanceOf(NativeError);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.reveal).not.toHaveBeenCalled();
});
it('retains accepted OS work through cancellation and exposes a readonly actual drain ticket', async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'note.txt'), 'owned');
  const grant = await f.cap.registry.createTrustedPath(f.home, 'directory', ['read']);
  const finish = Promise.withResolvers<void>();
  f.open.mockImplementationOnce(() => finish.promise);
  const signal = new AbortController(),
    key = crypto.randomUUID();
  const running = f.handlers['fileGrant.open'](
    { key, grantId: grant.grantId, path: 'note.txt' },
    signal.signal,
  );
  void Promise.resolve(running).catch(() => {});
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
  signal.abort();
  let drained = false;
  const waiting = Promise.resolve(
    f.handlers['fileGrant.application.drain']({ key }, f.signal()),
  ).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  finish.resolve();
  await waiting;
  await expect(running).rejects.toMatchObject({ code: 'MUTATION_FAILED' });
  await expect(
    f.handlers['fileGrant.open']({ key, grantId: grant.grantId, path: 'note.txt' }, f.signal()),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(f.open).toHaveBeenCalledTimes(1);
});
it('waits for an actual OS request when the shell owner retires', async () => {
  const f = await fixture();
  await writeFile(join(f.home, 'note.txt'), 'owned');
  const grant = await f.cap.registry.createTrustedPath(f.home, 'directory', ['read']);
  const finish = Promise.withResolvers<void>();
  f.reveal.mockImplementationOnce(() => finish.promise);
  const pending = f.handlers['fileGrant.reveal'](
    { key: crypto.randomUUID(), grantId: grant.grantId, path: 'note.txt' },
    f.signal(),
  );
  void Promise.resolve(pending).catch(() => {});
  await vi.waitFor(() => expect(f.reveal).toHaveBeenCalledTimes(1));
  let closed = false;
  const close = f.cap.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish.resolve();
  await close;
  await expect(pending).rejects.toBeInstanceOf(NativeError);
  expect(f.cap.resourceCount()).toBe(0);
});
it('Host cancellation does not release an accepted OS action until its native ticket drains', async () => {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  const generation = crypto.randomUUID();
  ctx.provide('runtimeIdentity', { generation } as never);
  const finish = Promise.withResolvers<boolean>();
  let callback: () => void = () => {};
  const call = vi.fn((method: string, _input: unknown, signal?: AbortSignal) =>
    method === 'fileGrant.application.drain'
      ? finish.promise
      : new Promise((_resolve, reject) => {
          callback = () => reject(new NativeError('CANCELLED'));
          signal?.addEventListener('abort', callback, { once: true });
        }),
  );
  ctx.provide('desktopNative', { generation, call } as unknown as NativeClient);
  await ctx.plugin(DesktopFileApplications);
  const action = ctx.fileApplications.open('owned', 'file.txt');
  void action.catch(() => {});
  let closed = false;
  const close = (ctx.fileApplications as DesktopFileApplications).close().then(() => {
    closed = true;
  });
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(closed).toBe(false);
  finish.resolve(true);
  await close;
  await expect(action).rejects.toMatchObject({ details: { reason: 'uncertain' } });
  expect(call.mock.calls[1]?.[0]).toBe('fileGrant.application.drain');
});
it('fails disposal if native drain cannot be proven after a transport failure', async () => {
  const ctx = new Context();
  const generation = crypto.randomUUID();
  ctx.provide('runtimeIdentity', { generation } as never);
  ctx.provide('desktopNative', {
    generation,
    call: vi.fn(async () => {
      throw new NativeError('CLOSED');
    }),
  } as unknown as NativeClient);
  await ctx.plugin(DesktopFileApplications);
  await expect(ctx.fileApplications.open('owned', 'file.txt')).rejects.toMatchObject({
    details: { reason: 'uncertain' },
  });
  await expect((ctx.fileApplications as DesktopFileApplications).close()).rejects.toMatchObject({
    details: { reason: 'uncertain' },
  });
  await ctx.fiber.dispose().catch(() => {});
});
