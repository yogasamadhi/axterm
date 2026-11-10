import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeWatchPath } from '../packages/infra/home-paths/lib/index.js';

export async function resolveDevelopmentHome(root, requested, userHome = homedir()) {
  const home = resolve(requested || join(root, 'out/level3/dev-home'));
  const [canonicalHome, productionHome] = await Promise.all([
    canonicalizeWatchPath(home),
    canonicalizeWatchPath(join(userHome, '.axterm')),
  ]);
  const suffix = relative(productionHome, canonicalHome);
  const outside = isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`);
  if (!outside)
    throw new Error(
      'The migration development launcher requires a home outside the production home',
    );
  return home;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const home = await resolveDevelopmentHome(root, process.env.AXTERM_HOME);
  const child = spawn(
    process.execPath,
    ['--expose-internals', join(root, 'apps/cli/lib/index.js'), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, AXTERM_HOME: home },
    },
  );
  const onTerm = () => child.kill('SIGTERM');
  const onInt = () => child.kill('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const removeListeners = () => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
  child.once('error', () => {
    removeListeners();
    process.exitCode = 1;
    console.error('Could not start the Profile launcher');
  });
  child.once('exit', (code, signal) => {
    removeListeners();
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 0 : 1);
  });
}
