import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { FileGrants } from '@axterm/plugin-api/host';
import { GrantedInputPaths } from '../../packages/plugins/files/src/adapters/input-paths.ts';
it('prepares actual pinned readable paths, fences generation and revokes retained files only when the Host owner closes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-input-paths-')),
    generation = randomUUID(),
    registry = new NativeFileGrantRegistry(generation);
  const revoke = vi.fn(async (id: string) => {
    registry.revoke(id);
  });
  const grants: Pick<FileGrants, 'authorize' | 'revoke'> = {
    revoke,
    authorize: async (id, permission, signal) => {
      const authority = await registry.authorize(id, permission, signal);
      let active = true;
      return {
        authority,
        signal: signal!,
        assert: () => {
          if (!active || signal?.aborted) throw Error('RETIRED');
        },
        dispose: () => {
          active = false;
        },
      };
    },
  };
  const port = {
    ...grants,
    create: async () => undefined,
    list: async () => [],
    resolveDirectory: async () => '',
    readText: async () => ({ name: '', content: '' }),
  };
  const owner = new GrantedInputPaths(generation, () => port);
  try {
    const path = join(home, 'read me.txt'),
      directory = join(home, 'directory');
    await writeFile(path, 'KEEP_ORIGINAL');
    await mkdir(directory);
    const file = await registry.createTrustedPath(path, 'file', ['read']),
      folder = await registry.createTrustedPath(directory, 'directory', ['read']);
    expect(
      await owner.prepare(generation, [file.grantId, folder.grantId], new AbortController().signal),
    ).toEqual([path, directory]);
    expect(revoke).not.toHaveBeenCalled();
    await expect(
      owner.prepare(randomUUID(), [file.grantId], new AbortController().signal),
    ).rejects.toMatchObject({ details: { reason: 'stale' } });
    const save = await registry.createTrustedPath(join(home, 'write-only.txt'), 'save-target', [
      'write',
    ]);
    await expect(
      owner.prepare(generation, [save.grantId], new AbortController().signal),
    ).rejects.toThrow();
    await owner.close();
    expect(revoke).toHaveBeenCalledExactlyOnceWith(file.grantId);
    expect(await readFile(path, 'utf8')).toBe('KEEP_ORIGINAL');
  } finally {
    await owner.close();
    registry.close();
    await rm(home, { recursive: true, force: true });
  }
});
