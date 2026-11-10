import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { relocateRuntimeLinks } from '../../scripts/package-level3-desktop.mjs';

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
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    await relocateRuntimeLinks(source, destination);
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
      join(root, 'app', 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(relocateRuntimeLinks(join(root, 'stage'), join(root, 'app'))).rejects.toThrow(
      'escaped the runtime closure',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
