import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveDevelopmentHome } from '../../scripts/run-level3-cli.mjs';

it('keeps source launches outside production home, including symlink aliases and dot-prefixed children', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-development-home-'));
  try {
    const user = join(root, 'user');
    await mkdir(join(user, '.axterm'), { recursive: true });
    await expect(resolveDevelopmentHome(root, undefined, user)).resolves.toBe(
      join(root, 'out/level3/dev-home'),
    );
    await expect(resolveDevelopmentHome(root, join(user, '.axterm'), user)).rejects.toThrow(
      'outside',
    );
    await expect(resolveDevelopmentHome(root, join(user, '.axterm/..cache'), user)).rejects.toThrow(
      'outside',
    );
    await symlink(join(user, '.axterm'), join(root, 'alias'), 'dir');
    await expect(resolveDevelopmentHome(root, join(root, 'alias/nested'), user)).rejects.toThrow(
      'outside',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
