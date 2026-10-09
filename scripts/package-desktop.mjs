import { spawn } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { snapshotNativeBuildDirectory } from './native-build-snapshot.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const desktopRoot = resolve(repositoryRoot, 'apps/desktop');
const require = createRequire(resolve(desktopRoot, 'package.json'));
const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js');

async function packageOptions(args) {
  let directoryOnly = false;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dir' && !directoryOnly) directoryOnly = true;
    else if (args[index] === '--output' && output === undefined) {
      output = args[++index];
      if (!output) throw new Error('Package output requires an absolute directory');
    } else throw new Error(`Unknown or repeated package option: ${args[index]}`);
  }
  if (output !== undefined) {
    if (!output || !isAbsolute(output))
      throw new Error('Package output must be an existing absolute directory');
    const details = await lstat(output);
    if (!details.isDirectory() || details.isSymbolicLink() || (await readdir(output)).length)
      throw new Error('Package output must be an empty, non-symlink directory');
    output = await realpath(output);
    if (output === repositoryRoot || output === desktopRoot)
      throw new Error('Package output cannot be a source root');
  }
  return { directoryOnly, output };
}

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

const options = await packageOptions(process.argv.slice(2));
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
      ...(options.directoryOnly ? ['--dir'] : []),
      ...(options.output ? [`--config.directories.output=${options.output}`] : []),
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
