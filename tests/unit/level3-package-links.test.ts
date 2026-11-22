import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { copyRuntimeTree } from '../../scripts/package-level3-desktop.mjs';
import { prepareWindowsInstallerInput } from '../../scripts/package-level3-installers.mjs';

it.runIf(process.platform === 'win32')(
  'archives a cyclic Windows dependency graph without junctions and restores it at a new path',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-nsis-links-'));
    try {
      const source = join(root, 'prepackaged');
      const target = join(root, 'installed Axterm');
      const packagePath = (name: string) =>
        join('resources', 'app', 'node_modules', '.axterm', name, 'package');
      const a = packagePath('a');
      const b = packagePath('b');
      for (const [index, path] of [a, b].entries()) {
        await mkdir(join(source, path, 'node_modules'), { recursive: true });
        await writeFile(join(source, path, 'name.txt'), String(index));
      }
      await symlink(join(source, b), join(source, a, 'node_modules', 'b'), 'junction');
      await symlink(join(source, a), join(source, b, 'node_modules', 'a'), 'junction');

      await prepareWindowsInstallerInput(source, target);
      const restored = join(target, a, 'node_modules', 'b');
      await expect(lstat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
      const installer = join(target, 'resources', 'axterm-restore-runtime-links.mjs');
      execFileSync(process.execPath, [installer]);
      expect(await realpath(restored)).toBe(await realpath(join(target, b)));
      expect(await readFile(join(restored, 'node_modules', 'a', 'name.txt'), 'utf8')).toBe('0');
      execFileSync(process.execPath, [installer]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('relocates absolute runtime links and retains relative links without depending on the source stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-package-links-'));
  try {
    const source = join(root, 'stage');
    const destination = join(root, 'app');
    await mkdir(join(source, 'instances', 'dependency'), { recursive: true });
    await writeFile(
      join(source, 'instances', 'dependency', 'entry.js'),
      'export const value = 42;',
    );
    await mkdir(join(source, 'node_modules'));
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(
      join(source, 'instances', 'dependency'),
      join(source, 'node_modules', 'absolute'),
      type,
    );
    await symlink(
      process.platform === 'win32'
        ? join(source, 'instances', 'dependency')
        : 'instances/dependency',
      join(source, 'relative'),
      type,
    );
    await copyRuntimeTree(source, destination);
    for (const path of ['node_modules/absolute', 'relative'])
      expect(await realpath(join(destination, path))).toBe(
        await realpath(join(destination, 'instances/dependency')),
      );
    await rm(source, { recursive: true });
    expect(await readFile(join(destination, 'node_modules/absolute/entry.js'), 'utf8')).toContain(
      '42',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a copied dependency link that escapes both runtime closures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-package-escape-'));
  try {
    await mkdir(join(root, 'stage'));
    await mkdir(join(root, 'app'));
    await mkdir(join(root, 'outside'));
    await symlink(
      join(root, 'outside'),
      join(root, 'stage', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(copyRuntimeTree(join(root, 'stage'), join(root, 'app'))).rejects.toThrow(
      'escaped the runtime closure',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
