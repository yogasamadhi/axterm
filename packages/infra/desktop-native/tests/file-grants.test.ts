import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  NativeClient,
  NativeServer,
  NativeError,
  nativeCapabilities,
  type NativeWire,
  type NativeFrame,
  type NativeHandlers,
} from '../src/index.ts';
import { ShellFileGrantCapabilities } from '../src/file-capabilities.ts';
import DesktopFileGrants from '../src/file-grants.ts';

const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
class Wire implements NativeWire {
  readonly identity = {};
  connected = true;
  peer!: Wire;
  readonly messages = new Set<(value: unknown) => void>();
  send(frame: NativeFrame): Promise<void> {
    const copy = structuredClone(frame);
    queueMicrotask(() => {
      for (const listener of this.peer.messages) listener(copy);
    });
    return Promise.resolve();
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.messages.add(listener);
    return () => {
      this.messages.delete(listener);
    };
  }
  onDisconnect(): () => void {
    return () => {};
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-host-grants-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const generation = randomUUID();
  const files = new ShellFileGrantCapabilities(generation, {
    choose: async () => undefined,
    defaultDirectory: () => directory,
    retire: () => {},
  });
  const host = new Wire();
  const shell = new Wire();
  host.peer = shell;
  shell.peer = host;
  const handlers = {
    ...Object.fromEntries(
      Object.keys(nativeCapabilities).map((key) => [
        key,
        () => {
          throw new NativeError('NOT_FOUND');
        },
      ]),
    ),
    ...files.handlers(),
  } as NativeHandlers;
  const server = new NativeServer(shell, generation, handlers, () => files.close());
  cleanups.push(() => server.close());
  const native = new NativeClient(host, generation);
  cleanups.push(() => native.close());
  const ctx = new Context();
  ctx.provide('runtimeIdentity', { generation, mode: 'desktop' });
  ctx.provide('desktopNative', native);
  const facade = new DesktopFileGrants(ctx);
  cleanups.push(() => facade.close());
  return { directory, files, facade, native };
}
it('resolves only granted directories and reads bounded exact-identity file contents in the Host', async () => {
  const { directory, files, facade } = await fixture();
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'key'), 'private-test-key');
  const folder = await facade.create({ kind: 'directory-path', path: directory });
  expect(folder).toBeDefined();
  expect(await facade.resolveDirectory(folder!.grantId, 'nested')).toBe(
    await realpath(join(directory, 'nested')),
  );
  await expect(facade.resolveDirectory(folder!.grantId, '../outside')).rejects.toMatchObject({
    details: { reason: 'invalid-input' },
  });
  const file = await files.registry.createTrustedPath(join(directory, 'key'), 'file', ['read']);
  expect(await facade.readText(file.grantId, 16)).toEqual({
    name: 'key',
    content: 'private-test-key',
  });
  await expect(facade.readText(file.grantId, 4)).rejects.toMatchObject({
    details: { reason: 'capacity' },
  });
  await expect(facade.authorize(file.grantId, 'write')).rejects.toMatchObject({
    details: { reason: 'forbidden' },
  });
  const listing = await facade.list();
  expect(listing).toHaveLength(2);
  expect(Object.isFrozen(listing)).toBe(true);
  expect(Object.isFrozen(listing[0]?.permissions)).toBe(true);
  expect(facade.resourceCount()).toBe(0);
});
it('revokes live and in-flight leases and retires all authority when the native generation closes', async () => {
  const { directory, facade, native } = await fixture();
  const folder = (await facade.create({ kind: 'directory-path', path: directory }))!;
  const lease = await facade.authorize(folder.grantId, 'read');
  expect(lease.signal.aborted).toBe(false);
  const pending = facade.authorize(folder.grantId, 'read');
  const rejected = expect(pending).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  await facade.revoke(folder.grantId);
  await rejected;
  expect(lease.signal.aborted).toBe(true);
  expect(() => lease.assert()).toThrow();
  await expect(facade.authorize(folder.grantId, 'read')).rejects.toMatchObject({
    details: { reason: 'not-found' },
  });
  const next = (await facade.create({ kind: 'directory-path', path: directory }))!;
  const active = await facade.authorize(next.grantId, 'read');
  native.close();
  expect(active.signal.aborted).toBe(true);
  await expect(facade.list()).rejects.toMatchObject({ details: { reason: 'closed' } });
  await facade.close();
  expect(facade.resourceCount()).toBe(0);
});
it('rejects replaced file and directory authority and symlink escapes without reading outside content', async () => {
  const { directory, files, facade } = await fixture();
  const selected = join(directory, 'selected');
  await mkdir(selected);
  await writeFile(join(selected, 'text'), 'original');
  const file = await files.registry.createTrustedPath(join(selected, 'text'), 'file', ['read']);
  await rename(join(selected, 'text'), join(selected, 'old'));
  await writeFile(join(selected, 'text'), 'replacement');
  await expect(facade.readText(file.grantId, 1024)).rejects.toMatchObject({
    details: { reason: 'stale' },
  });
  const folder = (await facade.create({ kind: 'directory-path', path: selected }))!;
  if (process.platform !== 'win32') {
    await symlink(directory, join(selected, 'escape'));
    await expect(facade.resolveDirectory(folder.grantId, 'escape')).rejects.toMatchObject({
      code: 'files/failure',
    });
  }
  await rename(selected, selected + '-old');
  await mkdir(selected);
  await expect(facade.resolveDirectory(folder.grantId, '')).rejects.toMatchObject({
    details: { reason: 'stale' },
  });
  expect(facade.resourceCount()).toBe(0);
});
