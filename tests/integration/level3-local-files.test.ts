import fs from 'node:fs/promises';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rename,
  rm,
  symlink,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type { FileGrantLease } from '@axterm/plugin-api/host';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { GrantedLocalFiles } from '../../packages/plugins/files/src/adapters/local-files.ts';
const cleanups: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const live = () => new AbortController().signal;
async function fixture(permissions: ('read' | 'write')[] = ['read', 'write']) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-owned-local-files-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanups.push(() => registry.close());
  let leases = 0;
  const grant = await registry.createTrustedPath(directory, 'directory', permissions);
  const local = new GrantedLocalFiles(() => ({
    authorize: async (id, permission, signal) => {
      let authority;
      try {
        authority = await registry.authorize(id, permission, signal);
      } catch (error) {
        const code = (error as { code: string }).code;
        throw new RemoteError('files/failure', 'Fixture grant refused', {
          reason: code === 'FORBIDDEN' ? 'forbidden' : code === 'STALE' ? 'stale' : 'not-found',
        });
      }
      leases++;
      let active = true;
      const lease: FileGrantLease = {
        authority,
        signal: signal ?? live(),
        assert: () => {
          if (!active || signal?.aborted)
            throw new RemoteError('files/failure', 'Fixture grant retired', {
              reason: 'cancelled',
            });
          if (!registry.list().items.some((item) => item.grantId === id))
            throw new RemoteError('files/failure', 'Fixture grant revoked', {
              reason: 'not-found',
            });
        },
        dispose: () => {
          if (active) {
            active = false;
            leases--;
          }
        },
      };
      return lease;
    },
  }));
  return { directory, registry, grant, local, leases: () => leases };
}
it('lists owned metadata and preserves directory-first ordering, exclusive creation, rename and deletion', async () => {
  const { directory, grant, local, leases } = await fixture();
  await local.create(grant.grantId, { path: '', name: 'z-folder', type: 'directory' }, live());
  await local.create(grant.grantId, { path: '', name: 'a-file', type: 'file' }, live());
  const listing = await local.list(grant.grantId, '', live());
  expect(listing.entries.map((entry) => entry.name)).toEqual(['z-folder', 'a-file']);
  expect(listing.truncated).toBe(false);
  expect(listing.entries[1]).toMatchObject({ type: 'file', size: 0 });
  expect(listing.entries[1]?.accessedAt).toMatch(/^\d{4}-/);
  if (process.platform !== 'win32') {
    expect((await lstat(join(directory, 'z-folder'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, 'a-file'))).mode & 0o777).toBe(0o600);
  }
  await expect(
    local.create(grant.grantId, { path: '', name: 'a-file', type: 'file' }, live()),
  ).rejects.toMatchObject({ details: { reason: 'conflict' } });
  await local.rename(grant.grantId, { path: 'a-file', name: 'renamed' }, live());
  await expect(
    local.rename(grant.grantId, { path: 'renamed', name: 'renamed' }, live()),
  ).rejects.toMatchObject({ details: { reason: 'conflict' } });
  await local.remove(grant.grantId, 'renamed', live());
  expect((await local.list(grant.grantId, '', live())).entries).toHaveLength(1);
  expect(leases()).toBe(0);
});
it('copies bounded trees, resolves conflicts and moves within the authorized root', async () => {
  const { directory, grant, local, leases } = await fixture();
  await mkdir(join(directory, 'source'));
  await mkdir(join(directory, 'destination'));
  await writeFile(join(directory, 'source/text.txt'), 'COPY_CONTENT');
  await local.chmod(grant.grantId, { path: 'source', mode: 0o750 }, live());
  expect(
    await local.operate(
      grant.grantId,
      { paths: ['source'], destination: 'destination', operation: 'copy', conflict: 'rename' },
      live(),
    ),
  ).toBe(2);
  expect(await readFile(join(directory, 'destination/source/text.txt'), 'utf8')).toBe(
    'COPY_CONTENT',
  );
  if (process.platform !== 'win32')
    expect((await lstat(join(directory, 'destination/source'))).mode & 0o777).toBe(0o750);
  expect(
    await local.operate(
      grant.grantId,
      { paths: ['source'], destination: 'destination', operation: 'copy', conflict: 'skip' },
      live(),
    ),
  ).toBe(0);
  await local.operate(
    grant.grantId,
    { paths: ['source'], destination: 'destination', operation: 'copy', conflict: 'rename' },
    live(),
  );
  expect(await readFile(join(directory, 'destination/source(copy-1)/text.txt'), 'utf8')).toBe(
    'COPY_CONTENT',
  );
  await writeFile(join(directory, 'source/text.txt'), 'REPLACED_CONTENT');
  await local.operate(
    grant.grantId,
    { paths: ['source'], destination: 'destination', operation: 'copy', conflict: 'overwrite' },
    live(),
  );
  expect(await readFile(join(directory, 'destination/source/text.txt'), 'utf8')).toBe(
    'REPLACED_CONTENT',
  );
  await local.operate(
    grant.grantId,
    { paths: ['source/text.txt'], destination: '', operation: 'move', conflict: 'rename' },
    live(),
  );
  expect(await readFile(join(directory, 'text.txt'), 'utf8')).toBe('REPLACED_CONTENT');
  await expect(
    local.operate(
      grant.grantId,
      {
        paths: ['destination'],
        destination: 'destination/source',
        operation: 'move',
        conflict: 'rename',
      },
      live(),
    ),
  ).rejects.toMatchObject({ details: { reason: 'invalid-input' } });
  expect(leases()).toBe(0);
});
it('rejects writes without permission, traversal, replaced roots and canceled admission', async () => {
  const denied = await fixture(['read']);
  await expect(
    denied.local.create(denied.grant.grantId, { path: '', name: 'denied', type: 'file' }, live()),
  ).rejects.toMatchObject({ details: { reason: 'forbidden' } });
  expect(denied.leases()).toBe(0);
  const { directory, local, grant, leases } = await fixture();
  await expect(local.list(grant.grantId, '../outside', live())).rejects.toMatchObject({
    code: 'files/failure',
  });
  const abort = new AbortController();
  abort.abort();
  await expect(
    local.create(grant.grantId, { path: '', name: 'late', type: 'file' }, abort.signal),
  ).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  const saved = directory + '-original';
  await rename(directory, saved);
  cleanups.push(() => rm(saved, { recursive: true, force: true }));
  await mkdir(directory);
  await expect(
    local.create(grant.grantId, { path: '', name: 'late', type: 'file' }, live()),
  ).rejects.toMatchObject({ details: { reason: 'stale' } });
  await expect(lstat(join(directory, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(leases()).toBe(0);
});
it.skipIf(process.platform === 'win32')(
  'never follows symlink escapes or changes a hardlinked file through directory authority',
  async () => {
    const { directory, local, grant, leases } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'axterm-local-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'protected'), 'KEEP');
    await symlink(outside, join(directory, 'escape'));
    await expect(local.list(grant.grantId, 'escape', live())).rejects.toMatchObject({
      code: 'files/failure',
    });
    await expect(
      local.create(grant.grantId, { path: 'escape', name: 'injected', type: 'file' }, live()),
    ).rejects.toMatchObject({ code: 'files/failure' });
    await expect(lstat(join(outside, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' });
    await local.remove(grant.grantId, 'escape', live());
    expect(await readFile(join(outside, 'protected'), 'utf8')).toBe('KEEP');
    await link(join(outside, 'protected'), join(directory, 'hardlink'));
    await expect(
      local.chmod(grant.grantId, { path: 'hardlink', mode: 0o600 }, live()),
    ).rejects.toMatchObject({ details: { reason: 'forbidden' } });
    expect(await readFile(join(outside, 'protected'), 'utf8')).toBe('KEEP');
    expect(leases()).toBe(0);
  },
);
it('truncates a large directory explicitly and releases its listing lease', async () => {
  const { directory, local, grant, leases } = await fixture();
  for (let offset = 0; offset < 10_001; offset += 32)
    await Promise.all(
      Array.from({ length: Math.min(32, 10_001 - offset) }, (_, index) =>
        writeFile(join(directory, `item-${String(offset + index).padStart(5, '0')}`), ''),
      ),
    );
  const listing = await local.list(grant.grantId, '', live());
  expect(listing.entries).toHaveLength(10_000);
  expect(listing.truncated).toBe(true);
  expect(leases()).toBe(0);
}, 30_000);

it('restarts a complete directory snapshot when an entry disappears after enumeration without publishing a partial result', async () => {
  const { directory, grant, local, leases } = await fixture();
  await writeFile(join(directory, 'stable.txt'), 'retained');
  await writeFile(join(directory, 'vanish.txt'), 'transient');
  const target = await fs.realpath(directory);
  const originalOpen = fs.opendir.bind(fs);
  let removed = false;
  let opened = 0;
  const spy = vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) {
      opened++;
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async () => {
          const entry = await originalRead();
          if (entry?.name === 'vanish.txt' && !removed) {
            removed = true;
            await rm(join(directory, 'vanish.txt'));
          }
          return entry;
        },
      });
    }
    return handle;
  });
  try {
    const result = await local.list(grant.grantId, '', live());
    expect(removed).toBe(true);
    expect(opened).toBeGreaterThan(1);
    expect(result.entries.map((entry) => entry.name)).toEqual(['stable.txt']);
    expect(leases()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('bounds retries for directory enumeration churn and releases the original grant lease', async () => {
  const { directory, grant, local, leases } = await fixture();
  const target = await fs.realpath(directory);
  const originalOpen = fs.opendir.bind(fs);
  let opened = 0;
  const spy = vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
    if (String(args[0]) === target) await writeFile(join(directory, 'vanish.txt'), 'transient');
    const handle = await originalOpen(...args);
    if (String(args[0]) === target) {
      opened++;
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async () => {
          const entry = await originalRead();
          if (entry?.name === 'vanish.txt') await rm(join(directory, 'vanish.txt'));
          return entry;
        },
      });
    }
    return handle;
  });
  try {
    await expect(local.list(grant.grantId, '', live())).rejects.toMatchObject({
      code: 'files/failure',
      details: { reason: 'not-found' },
    });
    expect(opened).toBe(3);
    expect(leases()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
