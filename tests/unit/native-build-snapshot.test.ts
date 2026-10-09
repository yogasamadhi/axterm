import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotNativeBuildDirectory } from '../../scripts/native-build-snapshot.mjs';

describe('native build snapshots', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('restores the exact Node build after Electron artifacts replace it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-native-snapshot-test-'));
    temporaryDirectories.push(root);
    const build = join(root, 'build');
    await mkdir(join(build, 'Release'), { recursive: true });
    await writeFile(join(build, '.axterm-node-137'), 'source-hash');
    await writeFile(join(build, 'Release', 'pty.node'), 'node-abi');
    const restore = await snapshotNativeBuildDirectory(build);

    await writeFile(join(build, 'Release', 'pty.node'), 'electron-abi');
    await writeFile(join(build, 'Release', 'electron-only'), 'temporary');
    await restore();
    await restore();

    expect((await readdir(build)).sort()).toEqual(['.axterm-node-137', 'Release']);
    expect(await readFile(join(build, 'Release', 'pty.node'), 'utf8')).toBe('node-abi');
    await expect(access(join(build, 'Release', 'electron-only'))).rejects.toThrow();
  });

  it('removes a generated build when no Node build existed before packaging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-native-snapshot-test-'));
    temporaryDirectories.push(root);
    const build = join(root, 'build');
    const restore = await snapshotNativeBuildDirectory(build);
    await mkdir(build, { recursive: true });
    await writeFile(join(build, 'electron-only'), 'temporary');

    await restore();

    await expect(access(build)).rejects.toThrow();
  });
});
