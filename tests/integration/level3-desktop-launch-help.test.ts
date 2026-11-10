import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
it('handles real Desktop help/version before home or Profile access', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'axterm-desktop-help-')),
    home = join(temp, 'untouched');
  try {
    const executable = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
    for (const flag of ['--help', '--version']) {
      const result = await promisify(execFile)(
        executable,
        [resolve('apps/desktop/lib/shell/main.js'), flag],
        {
          env: { ...process.env, HOME: temp, AXTERM_HOME: home, ELECTRON_RUN_AS_NODE: '' },
          timeout: 6000,
          maxBuffer: 32768,
        },
      );
      expect(result.stdout).toContain(flag === '--help' ? 'Axterm command line' : '0.10.0');
    }
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);
