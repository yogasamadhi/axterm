import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
  symlink,
  stat,
  rename,
} from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '../../packages/infra/desktop-native/src/grants.ts';
import { NativeManagedImports } from '../../packages/infra/desktop-native/src/managed-imports.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-managed-import-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanup.push(async () => registry.close());
  const imports = new NativeManagedImports(registry, join(home, 'imports'));
  cleanup.push(() => imports.close());
  return { home, registry, imports, signal: new AbortController().signal };
}
it('keeps provisional authority unlisted and publishes only a verified final file grant, then removes owned files', async () => {
  const f = await fixture();
  const provisional = await f.imports.prepare(
    { name: '文書.txt', size: 4, editable: false },
    f.signal,
  );
  expect(f.registry.list().items).toEqual([]);
  await expect(f.registry.authorize(provisional.grantId, 'read')).rejects.toThrow('FORBIDDEN');
  const write = await f.registry.authorize(provisional.grantId, 'write');
  await writeFile(join(write.rootPath, write.fileName!), 'safe', { flag: 'wx', mode: 0o600 });
  const granted = await f.imports.commit(provisional.grantId, f.signal);
  expect(granted.permissions).toEqual(['read']);
  expect(granted.name).toBe('文書.txt');
  expect(f.registry.list().items).toEqual([granted]);
  const read = await f.registry.authorize(granted.grantId, 'read');
  expect(await readFile(join(read.rootPath, read.fileName!), 'utf8')).toBe('safe');
  await expect(f.registry.authorize(provisional.grantId, 'write')).rejects.toThrow('NOT_FOUND');
  await f.imports.discard(granted.grantId);
  expect(f.registry.list().items).toEqual([]);
  expect(await readdir(join(f.home, 'imports'))).toEqual([]);
  expect(f.imports.resourceCount()).toBe(0);
});
it('refuses a size mismatch and a symlink replacement, preserving the outside file', async () => {
  const f = await fixture();
  const first = await f.imports.prepare({ name: 'file.txt', size: 4, editable: false }, f.signal);
  const write = await f.registry.authorize(first.grantId, 'write');
  await writeFile(join(write.rootPath, write.fileName!), 'bad');
  await expect(f.imports.commit(first.grantId, f.signal)).rejects.toThrow('INVALID');
  expect(f.imports.resourceCount()).toBe(0);
  const outside = join(f.home, 'outside');
  await writeFile(outside, 'safe');
  const second = await f.imports.prepare({ name: 'file.txt', size: 4, editable: true }, f.signal);
  const target = await f.registry.authorize(second.grantId, 'write');
  await symlink(outside, join(target.rootPath, target.fileName!));
  await expect(f.imports.commit(second.grantId, f.signal)).rejects.toThrow('INVALID');
  expect(await readFile(outside, 'utf8')).toBe('safe');
  expect(f.registry.list().items).toEqual([]);
  expect(f.imports.resourceCount()).toBe(0);
});
it('releases aborted admission and bounds reserved bytes without creating oversized files', async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.imports.prepare({ name: 'canceled', size: 4, editable: false }, abort.signal),
  ).rejects.toThrow('CANCELLED');
  expect(f.imports.resourceCount()).toBe(0);
  const maximum = 4 * 1024 * 1024 * 1024;
  const a = await f.imports.prepare({ name: 'a', size: maximum, editable: false }, f.signal);
  const b = await f.imports.prepare({ name: 'b', size: maximum, editable: false }, f.signal);
  expect(() => f.imports.prepare({ name: 'over', size: 1, editable: false }, f.signal)).toThrow(
    'LIMIT',
  );
  await Promise.all([f.imports.discard(a.grantId), f.imports.discard(b.grantId)]);
  expect(f.imports.resourceCount()).toBe(0);
  await f.imports.close();
  await expect(stat(join(f.home, 'imports'))).rejects.toMatchObject({ code: 'ENOENT' });
  await setImmediate();
  await expect(stat(join(f.home, 'imports'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(() => f.imports.prepare({ name: 'closed', size: 0, editable: false }, f.signal)).toThrow(
    'CLOSED',
  );
});

it('refuses an existing import root and preserves its contents during failed initialization and close', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-root-conflict-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, 'imports');
  await mkdir(directory);
  await writeFile(join(directory, 'existing'), 'preserved');
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanup.push(async () => registry.close());
  const imports = new NativeManagedImports(registry, directory);
  cleanup.push(() => imports.close());
  await expect(
    imports.prepare({ name: 'new', size: 0, editable: false }, new AbortController().signal),
  ).rejects.toThrow('IO');
  await imports.close();
  expect(await readFile(join(directory, 'existing'), 'utf8')).toBe('preserved');
  expect(imports.resourceCount()).toBe(0);
});

it('retains a failed root cleanup, rejects repeated close consistently and preserves an unexpected file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-cleanup-failure-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanup.push(async () => registry.close());
  const directory = join(home, 'imports');
  const imports = new NativeManagedImports(registry, directory);
  const grant = await imports.prepare(
    { name: 'new', size: 0, editable: false },
    new AbortController().signal,
  );
  await imports.discard(grant.grantId);
  await writeFile(join(directory, 'unexpected'), 'preserve');
  const close = imports.close();
  expect(imports.close()).toBe(close);
  await expect(close).rejects.toThrow('IO');
  await expect(imports.close()).rejects.toThrow('IO');
  expect(imports.resourceCount()).toBeGreaterThan(0);
  expect(await readFile(join(directory, 'unexpected'), 'utf8')).toBe('preserve');
});

it('rejects expired provisional authority and drains its managed stage without publication', async () => {
  const f = await fixture();
  const provisional = await f.imports.prepare(
    { name: 'expired.txt', size: 0, editable: false },
    f.signal,
  );
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60 * 1000 + 1);
  try {
    await expect(f.imports.commit(provisional.grantId, f.signal)).rejects.toThrow('LEASE_EXPIRED');
    expect(f.registry.list().items).toEqual([]);
    expect(f.imports.resourceCount()).toBe(0);
    expect(await readdir(join(f.home, 'imports'))).toEqual([]);
  } finally {
    time.mockRestore();
  }
});

it('preserves a replacement import directory and retains failed cleanup instead of deleting its foreign contents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-replaced-stage-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanup.push(async () => registry.close());
  const imports = new NativeManagedImports(registry, join(home, 'imports'));
  const signal = new AbortController().signal;
  const grant = await imports.prepare({ name: 'file.txt', size: 0, editable: false }, signal);
  const authority = await registry.authorize(grant.grantId, 'write');
  await rename(authority.rootPath, join(home, 'original-stage'));
  await mkdir(authority.rootPath);
  const foreign = join(authority.rootPath, 'preserve.txt');
  await writeFile(foreign, 'foreign preserved');
  await expect(imports.commit(grant.grantId, signal)).rejects.toThrow('STALE');
  expect(await readFile(foreign, 'utf8')).toBe('foreign preserved');
  expect(imports.resourceCount()).toBeGreaterThan(0);
  await expect(imports.close()).rejects.toThrow('IO');
  expect(await readFile(foreign, 'utf8')).toBe('foreign preserved');
});
