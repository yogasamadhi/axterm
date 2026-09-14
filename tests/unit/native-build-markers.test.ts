import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeNodeAbiMarkers } from '../../scripts/rebuild-native.mjs';

describe('native build ABI markers', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('invalidates every Node ABI marker after an Electron rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-native-markers-'));
    temporaryDirectories.push(root);
    const build = join(root, 'build');
    await mkdir(build);
    await Promise.all([
      writeFile(join(build, '.axterm-node-137'), 'source-hash'),
      writeFile(join(build, '.axterm-node-138'), 'source-hash'),
      writeFile(join(build, 'config.gypi'), 'keep'),
    ]);

    await removeNodeAbiMarkers(root);

    expect((await readdir(build)).sort()).toEqual(['config.gypi']);
  });
});
