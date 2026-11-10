import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '../src/grants.ts';
import { ShellFileGrantCapabilities } from '../src/file-capabilities.ts';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(capacity?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-native-grants-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID(), capacity);
  cleanups.push(() => registry.close());
  return { directory, registry };
}
it('captures detached generation-bound authority and checks permissions and exact file identity', async () => {
  const { directory, registry } = await fixture();
  const path = join(directory, 'controlled.txt');
  await writeFile(path, 'controlled-content');
  const grant = await registry.createTrustedPath(path, 'file', ['read']);
  expect(grant).toMatchObject({ kind: 'file', name: 'controlled.txt', permissions: ['read'] });
  grant.permissions.push('write');
  grant.name = 'mutated';
  const authority = await registry.authorize(grant.grantId, 'read');
  expect(authority).toMatchObject({
    generation: registry.generation,
    rootPath: await realpath(directory),
    fileName: 'controlled.txt',
    grant: { name: 'controlled.txt', permissions: ['read'] },
  });
  expect(authority.fileIdentity?.inode).toMatch(/^\d+$/);
  await expect(registry.authorize(grant.grantId, 'write')).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  authority.grant.permissions.push('write');
  await expect(registry.authorize(grant.grantId, 'write')).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  registry.revoke(grant.grantId);
  await expect(registry.authorize(grant.grantId, 'read')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  registry.revoke(grant.grantId);
});
it('rejects replaced roots, replaced files, symlink targets and unconsented save-target collisions', async () => {
  const { directory, registry } = await fixture();
  const root = join(directory, 'root');
  await mkdir(root);
  const folder = await registry.createTrustedPath(root, 'directory', ['read', 'write']);
  await rename(root, root + '-original');
  await mkdir(root);
  await expect(registry.authorize(folder.grantId, 'read')).rejects.toMatchObject({ code: 'STALE' });
  const path = join(directory, 'file');
  await writeFile(path, 'original');
  const file = await registry.createTrustedPath(path, 'file', ['read']);
  await rename(path, path + '-original');
  await writeFile(path, 'replacement');
  await expect(registry.authorize(file.grantId, 'read')).rejects.toMatchObject({ code: 'STALE' });
  const target = join(directory, 'new-save');
  const save = await registry.createTrustedPath(target, 'save-target', ['write']);
  expect((await registry.authorize(save.grantId, 'write')).fileIdentity).toBeUndefined();
  await writeFile(target, 'another-writer');
  await expect(registry.authorize(save.grantId, 'write')).rejects.toMatchObject({ code: 'STALE' });
  if (process.platform !== 'win32') {
    const alias = join(directory, 'save-link');
    await symlink(path, alias);
    await expect(registry.createTrustedPath(alias, 'save-target', ['write'])).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  }
});
it('keeps pages coherent, expires authority, enforces admission and releases the registry on generation close', async () => {
  const { directory, registry } = await fixture(2);
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  cleanups.push(() => clock.mockRestore());
  const one = await registry.createTrustedPath(directory, 'directory', ['read'], 1000);
  const two = await registry.createTrustedPath(directory, 'directory', ['read']);
  const page = registry.list(0, 1);
  expect(page.items).toHaveLength(1);
  expect(page.nextOffset).toBe(1);
  expect(registry.list(1, 1, page.revision).items[0]?.grantId).toBe(two.grantId);
  await expect(registry.createTrustedPath(directory, 'directory', ['read'])).rejects.toMatchObject({
    code: 'LIMIT',
  });
  registry.revoke(two.grantId);
  expect(() => registry.list(1, 1, page.revision)).toThrowError(
    expect.objectContaining({ code: 'STALE' }),
  );
  clock.mockReturnValue(now + 1001);
  await expect(registry.authorize(one.grantId, 'read')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(registry.resourceCount()).toBe(0);
  const pending = registry.createTrustedPath(directory, 'directory', ['read']);
  registry.close();
  await expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
  await expect(registry.authorize(one.grantId, 'read')).rejects.toMatchObject({ code: 'CLOSED' });
  const restarted = new NativeFileGrantRegistry(randomUUID());
  try {
    await expect(restarted.authorize(one.grantId, 'read')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  } finally {
    restarted.close();
  }
});
it('never mints a late canceled native selection and drains the native driver on generation retirement', async () => {
  const { directory } = await fixture();
  const path = join(directory, 'selection.txt');
  await writeFile(path, 'selection');
  let selection = Promise.withResolvers<string | undefined>();
  const choose = vi.fn(() => selection.promise);
  const retire = vi.fn(() => selection.resolve(path));
  const facility = new ShellFileGrantCapabilities(randomUUID(), {
    choose,
    defaultDirectory: () => directory,
    retire,
  });
  cleanups.push(() => facility.close());
  const handlers = facility.handlers();
  const abort = new AbortController();
  const pending = handlers['fileGrant.create']({ kind: 'open-file' }, abort.signal);
  expect(facility.resourceCount()).toBe(1);
  await expect(
    handlers['fileGrant.create']({ kind: 'open-file' }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'LIMIT' });
  abort.abort();
  selection.resolve(path);
  await expect(pending).rejects.toThrow();
  expect(facility.registry.resourceCount()).toBe(0);
  selection = Promise.withResolvers<string | undefined>();
  const second = handlers['fileGrant.create']({ kind: 'open-file' }, new AbortController().signal);
  const settled = Promise.resolve(second).catch((error) => error);
  await facility.close();
  expect(retire).toHaveBeenCalledOnce();
  expect(await settled).toMatchObject({ code: 'CLOSED' });
  expect(facility.resourceCount()).toBe(0);
  expect(facility.registry.resourceCount()).toBe(0);
});
