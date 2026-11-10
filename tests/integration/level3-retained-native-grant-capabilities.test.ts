import type {} from '@axterm/ui';
import { localAbsoluteAddress } from '../../packages/plugins/files/src/client/ui/file-manager-model.ts';
import { mkdir, readFile, stat, symlink, access, realpath, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
import { GrantedLocalFiles } from '../../packages/plugins/files/src/adapters/local-files.ts';
import DesktopFileApplications from '../../packages/infra/desktop-native/src/applications.ts';
const live: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of live.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
async function fixture() {
  const paths = { home: '', downloads: '', selected: '' },
    opened: string[] = [],
    revealed: string[] = [];
  const getDirectory = vi.fn((kind: 'home' | 'downloads') => paths[kind]);
  const f = await createManagedImportFixture('web', {
    chooser: {
      choose: async () => paths.selected,
      defaultDirectory: getDirectory,
      retire() {},
    },
    applications: {
      open: async (path) => {
        opened.push(path);
      },
      reveal: async (path) => {
        revealed.push(path);
      },
    },
  });
  live.push(f.close);
  paths.home = join(f.home, 'home');
  paths.downloads = join(f.home, 'Downloads');
  paths.selected = join(f.home, 'selected');
  f.ctx.provide('desktopNative', f.native);
  new DesktopFileApplications(f.ctx);
  return {
    ...f,
    getDirectory,
    paths,
    opened,
    revealed,
    local: new GrantedLocalFiles(() => f.ctx.fileGrants),
  };
}
it('refuses a Downloads file without falling back to home or changing its bytes', async () => {
  const f = await fixture();
  await mkdir(f.paths.home);
  await writeFile(f.paths.downloads, 'keep existing bytes');
  await expect(
    f.ctx.fileGrants.create({ kind: 'downloads-directory' }, signal()),
  ).rejects.toMatchObject({ code: 'files/failure' });
  expect(await f.ctx.fileGrants.list()).toEqual([]);
  expect(await readFile(f.paths.downloads, 'utf8')).toBe('keep existing bytes');
});
it('grants actual system-home and explicitly entered absolute directory through the native bridge', async () => {
  const f = await fixture();
  await mkdir(f.paths.home);
  await mkdir(f.paths.selected);
  await writeFile(join(f.paths.home, 'home.txt'), 'home');
  const home = await f.ctx.fileGrants.create({ kind: 'home-directory' }, signal());
  expect(home).toMatchObject({
    rootPath: await realpath(f.paths.home),
    permissions: ['read', 'write'],
  });
  expect(home).not.toHaveProperty('path');
  expect(await f.local.list(home!.grantId, '', signal())).toMatchObject({
    entries: [{ name: 'home.txt', path: 'home.txt' }],
  });
  const other = await f.ctx.fileGrants.create(
    { kind: 'directory-path', path: f.paths.selected },
    signal(),
  );
  expect(other).toMatchObject({ rootPath: await realpath(f.paths.selected) });
});
it('retains complete bounded local metadata, native actions and original relative file operations within granted authority', async () => {
  const f = await fixture(),
    selected = f.paths.selected;
  await mkdir(join(selected, 'folder'), { recursive: true });
  await writeFile(join(selected, 'notes.txt'), 'local file');
  await writeFile(join(selected, 'folder/nested.txt'), 'nested local file');
  const grant = (await f.ctx.fileGrants.create({ kind: 'open-directory' }, signal()))!;
  expect(grant).toMatchObject({ name: 'selected', rootPath: await realpath(selected) });
  expect(grant).not.toHaveProperty('path');
  const root = await f.local.list(grant.grantId, '', signal());
  expect(root).toMatchObject({
    rootName: 'selected',
    path: '',
    entries: [
      { name: 'folder', path: 'folder', type: 'directory' },
      { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 10 },
    ],
  });
  expect(root.entries[1]).toMatchObject({
    accessedAt: expect.any(String),
    owner: expect.any(String),
    group: expect.any(String),
  });
  const nested = await f.local.list(grant.grantId, 'folder', signal());
  expect(nested.entries).toMatchObject([
    { name: 'nested.txt', path: 'folder/nested.txt', type: 'file' },
  ]);
  const lease = await f.files.open(grant.grantId, 'read', signal());
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await lease.read('notes.txt')) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('local file');
    expect((await lease.stat('')).type).toBe('directory');
  } finally {
    await lease.close();
  }
  await f.local.create(
    grant.grantId,
    { path: 'folder', name: 'created.txt', type: 'file' },
    signal(),
  );
  expect(await readFile(join(selected, 'folder/created.txt'), 'utf8')).toBe('');
  await f.local.create(
    grant.grantId,
    { path: '', name: 'created-dir', type: 'directory' },
    signal(),
  );
  await expect(
    f.local.create(grant.grantId, { path: '', name: 'notes.txt', type: 'file' }, signal()),
  ).rejects.toMatchObject({ details: { reason: 'conflict' } });
  await f.local.rename(grant.grantId, { path: 'notes.txt', name: 'renamed.txt' }, signal());
  expect(await readFile(join(selected, 'renamed.txt'), 'utf8')).toBe('local file');
  await f.local.chmod(grant.grantId, { path: 'renamed.txt', mode: 0o640 }, signal());
  expect((await stat(join(selected, 'renamed.txt'))).mode & 0o7777).toBe(0o640);
  if (process.platform !== 'win32') {
    await symlink(join(selected, 'renamed.txt'), join(selected, 'renamed-link'));
    await expect(
      f.local.chmod(grant.grantId, { path: 'renamed-link', mode: 0o777 }, signal()),
    ).rejects.toThrow();
    expect((await stat(join(selected, 'renamed.txt'))).mode & 0o7777).toBe(0o640);
  }
  expect(['renamed.txt', 'folder'].map((path) => localAbsoluteAddress(grant, path))).toEqual([
    join(await realpath(selected), 'renamed.txt'),
    join(await realpath(selected), 'folder'),
  ]);
  await f.ctx.fileApplications.open(grant.grantId, 'renamed.txt', signal());
  await f.ctx.fileApplications.reveal(grant.grantId, 'folder', signal());
  expect(f.opened).toEqual([join(await realpath(selected), 'renamed.txt')]);
  expect(f.revealed).toEqual([join(await realpath(selected), 'folder')]);
  await f.local.operate(
    grant.grantId,
    { paths: ['renamed.txt'], destination: '', operation: 'copy', conflict: 'rename' },
    signal(),
  );
  expect(await readFile(join(selected, 'renamed(copy-1).txt'), 'utf8')).toBe('local file');
  await f.local.operate(
    grant.grantId,
    { paths: ['folder'], destination: 'created-dir', operation: 'copy', conflict: 'rename' },
    signal(),
  );
  expect(await readFile(join(selected, 'created-dir/folder/nested.txt'), 'utf8')).toBe(
    'nested local file',
  );
  await f.local.operate(
    grant.grantId,
    {
      paths: ['folder/created.txt'],
      destination: 'created-dir',
      operation: 'move',
      conflict: 'rename',
    },
    signal(),
  );
  expect(await readFile(join(selected, 'created-dir/created.txt'), 'utf8')).toBe('');
  await expect(access(join(selected, 'folder/created.txt'))).rejects.toThrow();
  await expect(
    f.local.operate(
      grant.grantId,
      { paths: ['folder'], destination: 'folder', operation: 'move', conflict: 'rename' },
      signal(),
    ),
  ).rejects.toThrow();
  await f.local.remove(grant.grantId, 'created-dir', signal());
  await expect(access(join(selected, 'created-dir'))).rejects.toThrow();
  await expect(f.local.remove(grant.grantId, '../outside', signal())).rejects.toThrow();
  expect(f.grantOwner.resourceCount()).toBe(0);
  expect(f.capabilities.resourceCount()).toBe(0);
});

it.each([false, true])(
  'resolves the actual localized OS Downloads path and preserves grant boundaries (already exists: %s)',
  async (exists) => {
    const f = await fixture();
    f.paths.downloads = join(f.home, '重定向下载');
    if (exists) await mkdir(f.paths.downloads);
    const grant = (await f.ctx.fileGrants.create({ kind: 'downloads-directory' }, signal()))!;
    expect(f.getDirectory).toHaveBeenCalledExactlyOnceWith('downloads');
    expect(grant).toMatchObject({
      kind: 'directory',
      rootPath: await realpath(f.paths.downloads),
      permissions: ['read', 'write'],
    });
    expect(grant).not.toHaveProperty('path');
    await f.local.create(grant.grantId, { path: '', name: 'download.txt', type: 'file' }, signal());
    expect(await readFile(join(f.paths.downloads, 'download.txt'), 'utf8')).toBe('');
    await expect(f.local.list(grant.grantId, '../', signal())).rejects.toThrow();
    await f.ctx.fileGrants.revoke(grant.grantId, signal());
    await expect(f.local.list(grant.grantId, '', signal())).rejects.toThrow();
  },
);

it.each([false, true])(
  'retains original dropped/editable bytes, expiring metadata, path privacy and revoke cleanup (editable: %s)',
  async (editable) => {
    const f = await fixture(),
      name = editable ? 'remote notes.txt' : '中文 file.txt',
      body = editable ? 'draft' : 'hello world!';
    const pending = await f.ctx.fileImports.prepare(
      { name, size: Buffer.byteLength(body), editable },
      signal(),
    );
    expect(await f.ctx.fileGrants.list()).toEqual([]);
    const writer = await f.files.open(pending.grantId, 'write', signal());
    try {
      await writer.write(writer.path, Readable.from([Buffer.from(body)]), {
        overwrite: true,
        mode: 0o600,
      });
    } finally {
      await writer.close();
    }
    const grant = await f.ctx.fileImports.commit(pending.grantId, signal());
    expect(grant.name).toBe(name);
    expect(grant.permissions).toEqual(editable ? ['read', 'write'] : ['read']);
    expect(grant).not.toHaveProperty('path');
    expect(Date.parse(grant.expiresAt!)).toBeGreaterThan(Date.now());
    const authority = await f.capabilities.registry.authorize(grant.grantId, 'read'),
      path = join(authority.rootPath, authority.fileName!);
    expect(await readFile(path, 'utf8')).toBe(body);
    if (editable) {
      await f.ctx.fileApplications.open(grant.grantId, '', signal());
      expect(f.opened).toEqual([path]);
    }
    expect(JSON.stringify([...f.shell.frames, ...f.host.frames])).not.toContain(body);
    await expect(
      f.ctx.fileImports.prepare({ name: 'bad"name', size: 12, editable: false }, signal()),
    ).rejects.toThrow();
    await f.ctx.fileGrants.revoke(grant.grantId, signal());
    await expect(access(path)).rejects.toThrow();
    await expect(access(dirname(path))).rejects.toThrow();
    expect(await f.ctx.fileGrants.list()).toEqual([]);
  },
);
