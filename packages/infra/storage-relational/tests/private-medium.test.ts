import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RelationalStorageBackend } from '../src/backend.ts';
async function rejected(path: string) {
  const backend = new RelationalStorageBackend(path);
  try {
    await expect(backend.initialize()).rejects.toMatchObject({ code: 'malformed-medium' });
  } finally {
    await backend.close();
  }
}
it('creates private disk media and permits a clean reopen of the same single inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-private-medium-'));
  try {
    const path = join(root, 'data', 'facts.sqlite'),
      first = new RelationalStorageBackend(path);
    await first.initialize();
    await first.close();
    const before = await stat(path);
    const next = new RelationalStorageBackend(path);
    await next.initialize();
    await next.close();
    expect((await stat(path)).ino).toBe(before.ino);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect((await stat(join(root, 'data'))).mode & 0o077).toBe(0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform === 'win32')(
  'refuses symbolic and hard links before writing database or sidecar targets',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-private-medium-alias-'));
    try {
      for (const suffix of ['', '-wal', '-shm'])
        for (const kind of ['symlink', 'hardlink']) {
          const directory = join(root, `${kind}${suffix || '-db'}`);
          await mkdir(directory, { mode: 0o700 });
          const target = join(directory, 'retained'),
            path = join(directory, 'facts.sqlite');
          await writeFile(target, 'RETAINED_INPUT', { mode: 0o600 });
          if (suffix) await writeFile(path, '', { mode: 0o600 });
          if (kind === 'symlink') await symlink(target, path + suffix);
          else await link(target, path + suffix);
          await rejected(path);
          expect(await readFile(target, 'utf8')).toBe('RETAINED_INPUT');
          if (suffix) expect(await readFile(path)).toHaveLength(0);
        }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects group-readable files and a shared parent without chmod or content changes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-private-medium-mode-'));
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const directory = join(root, suffix || 'db');
        await mkdir(directory, { mode: 0o700 });
        const path = join(directory, 'facts.sqlite');
        await writeFile(path, '', { mode: 0o600 });
        await writeFile(path + suffix, '', { mode: 0o600 });
        await chmod(path + suffix, 0o640);
        await rejected(path);
        expect((await stat(path + suffix)).mode & 0o777).toBe(0o640);
        expect(await readFile(path)).toHaveLength(0);
      }
      const parent = join(root, 'shared');
      await mkdir(parent, { mode: 0o700 });
      await chmod(parent, 0o750);
      const path = join(parent, 'facts.sqlite');
      await writeFile(path, '', { mode: 0o600 });
      await rejected(path);
      expect((await stat(parent)).mode & 0o777).toBe(0o750);
      expect(await readFile(path)).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform === 'win32')(
  'does not create media through a symlinked or shared immediate parent',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-private-parent-'));
    try {
      const target = join(root, 'target'),
        alias = join(root, 'alias');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, alias);
      await rejected(join(alias, 'facts.sqlite'));
      await expect(stat(join(target, 'facts.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
      await chmod(target, 0o750);
      await rejected(join(target, 'facts.sqlite'));
      await expect(stat(join(target, 'facts.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
