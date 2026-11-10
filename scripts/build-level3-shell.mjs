import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'tsdown';
/** The complete build and targeted carrier verification use this same shell build. */
export async function buildLevel3Shell(root = resolve(import.meta.dirname, '..')) {
  // The ordinary Desktop entry and targeted validation use this same Shell build.
  const desktop = join(root, 'apps/desktop');
  const shellCheck = spawnSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(desktop, 'tsconfig.shell.json')],
    { stdio: 'inherit' },
  );
  if (shellCheck.status !== 0) throw new Error('Strict Desktop shell check failed');
  const shellOutput = join(desktop, 'lib/shell');
  await rm(shellOutput, { recursive: true, force: true });
  await build({
    entry: {
      main: join(desktop, 'src/shell/index.ts'),
      application: join(desktop, 'src/shell/application.ts'),
      'data-copy': join(desktop, 'src/shell/data-copy.ts'),
      'file-chooser': join(desktop, 'src/shell/file-chooser.ts'),
      'native-panel': join(desktop, 'src/shell/native-panel.ts'),
    },
    outDir: shellOutput,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: desktop,
    deps: { neverBundle: [/^(?!\0)[^./]/] },
    logLevel: 'warn',
  });
  await build({
    entry: { preload: join(desktop, 'src/shell/preload.ts') },
    outDir: shellOutput,
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: true,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: desktop,
    deps: {
      neverBundle: (name) => name === 'electron',
      alwaysBundle: (name) => name !== 'electron',
    },
    logLevel: 'warn',
  });
  console.info('Built the isolated Level 3 Desktop shell and sandboxed bootstrap preload.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildLevel3Shell();
