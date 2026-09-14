import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('fails the real gate for forbidden dependencies, including portable-package laundering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-architecture-'));
  try {
    for (const name of ['runtime', 'contracts', 'client', 'db-schema', 'shared'])
      await mkdir(join(directory, `packages/${name}/src`), { recursive: true });
    // Exercise resolved vendor paths too, not only unresolved bare specifiers.
    for (const name of ['electron', 'ssh2', 'node-pty', 'drizzle-orm', 'hono']) {
      const packageDirectory = join(directory, 'node_modules', name);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        join(packageDirectory, 'package.json'),
        JSON.stringify({ name, main: 'index.js' }),
      );
      await writeFile(join(packageDirectory, 'index.js'), 'module.exports = {};');
    }
    const fixtures = {
      'apps/desktop/tsconfig.web.json':
        '{"compilerOptions":{"moduleResolution":"Bundler","module":"ESNext"}}',
      'apps/desktop/src/renderer/src/index.ts':
        "import fs from 'node:fs'; import 'electron'; import 'ssh2'; import 'node-pty'; import 'drizzle-orm'; import '../../../../../packages/shared/src/index'; export const bad = fs;",
      'apps/desktop/src/main/index.ts':
        "import '../../../../packages/runtime/src/domain/hosts/index';",
      'packages/runtime/src/entry/desktop.ts': "import 'electron';",
      'packages/runtime/src/domain/hosts/index.ts':
        "import 'hono'; import 'ssh2'; import 'node-pty'; import 'drizzle-orm';",
      'packages/shared/src/index.ts': "import 'node:fs';",
    };
    for (const [path, source] of Object.entries(fixtures)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), source);
    }
    const result = await promisify(execFile)(
      process.execPath,
      [resolve('scripts/architecture-check.mjs')],
      { cwd: directory },
    ).then(
      () => ({ rejected: false, output: '' }),
      (error: { stderr: string; stdout: string; code: number }) => ({
        rejected: error.code === 1,
        output: error.stdout + error.stderr,
      }),
    );
    expect(result.rejected).toBe(true);
    for (const rule of [
      'renderer-no-node-builtins',
      'portable-no-node-builtins',
      'runtime-no-electron-or-bun',
      'domain-no-infrastructure',
      'main-no-runtime-implementation',
    ])
      expect(result.output).toContain(rule);
    for (const vendor of ['electron', 'ssh2', 'node-pty', 'drizzle-orm']) {
      expect(result.output).toContain(
        `renderer-no-host-or-runtime: apps/desktop/src/renderer/src/index.ts -> node_modules/${vendor}/index.js`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
