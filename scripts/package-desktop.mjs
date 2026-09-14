import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { snapshotNativeBuildDirectory } from './native-build-snapshot.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const desktopRoot = resolve(repositoryRoot, 'apps/desktop');
const require = createRequire(resolve(desktopRoot, 'package.json'));
const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js');

async function run(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolveExit(exitCode ?? 1);
    });
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}

const nodePtyRoot = await realpath(resolve(desktopRoot, 'node_modules/node-pty'));
const restoreNodeBuild = await snapshotNativeBuildDirectory(resolve(nodePtyRoot, 'build'));
try {
  await run(
    process.execPath,
    [resolve(repositoryRoot, 'scripts/rebuild-native.mjs')],
    repositoryRoot,
  );

  // Local packaging must never inspect a developer's login keychain for a signing
  // identity. Explicit release credentials (for example CSC_LINK) remain usable,
  // but electron-builder's ambient certificate discovery is always disabled.
  await run(
    process.execPath,
    [
      electronBuilderCli,
      ...(process.argv.includes('--dir') ? ['--dir'] : []),
      '--publish',
      'never',
    ],
    desktopRoot,
    { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  );
} finally {
  // The package already owns its copied Electron ABI artifacts. Restore the workspace's
  // exact Node build even when rebuild or packaging fails so later headless tests remain valid.
  await restoreNodeBuild();
}
