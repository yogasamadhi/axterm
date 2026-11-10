import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDevelopmentHome } from './run-level3-cli.mjs';

export async function desktopDevelopmentLaunch(
  root,
  environment = process.env,
  userHome = homedir(),
) {
  root = resolve(root);
  const home = await resolveDevelopmentHome(root, environment.AXTERM_HOME, userHome);
  const args = environment.ELECTRON_CLI_ARGS ? JSON.parse(environment.ELECTRON_CLI_ARGS) : [];
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some(
      (arg) => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 8192,
    )
  )
    throw Error('Invalid desktop development arguments');
  for (const path of [
    'apps/desktop/lib/shell/main.js',
    'apps/desktop-host/lib/index.js',
    'apps/web/dist/index.html',
  ])
    await access(join(root, path));
  const command = createRequire(join(root, 'apps/desktop/package.json'))('electron');
  if (typeof command !== 'string') throw Error('Electron development executable is unavailable');
  return {
    command,
    args: [join(root, 'apps/desktop'), ...args],
    cwd: root,
    env: {
      ...environment,
      AXTERM_HOME: home,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_RENDERER_URL: '',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const launch = await desktopDevelopmentLaunch(resolve(import.meta.dirname, '..'));
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: 'inherit',
  });
  const interrupt = () => child.kill('SIGINT'),
    terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    process.exitCode = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        done(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
      );
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
