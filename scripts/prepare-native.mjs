import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const ptyRoot = await realpath(resolve('packages/runtime/node_modules/node-pty')).catch(
  () => undefined,
);

if (process.platform === 'darwin' && ptyRoot) {
  const sourcePath = join(ptyRoot, 'src/unix/pty.cc');
  const sourceHash = createHash('sha256')
    .update(await readFile(sourcePath))
    .digest('hex');
  const marker = join(ptyRoot, 'build', `.axterm-node-${process.versions.modules}`);
  const preparedHash = await readFile(marker, 'utf8').catch(() => '');
  if (preparedHash !== sourceHash) {
    await run(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild'], ptyRoot);
    await writeFile(marker, sourceHash, { mode: 0o600 });
  }
}

if (process.platform !== 'win32') {
  for (const helper of [
    resolve(
      'packages/runtime/node_modules/node-pty/prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    ),
    resolve('packages/runtime/node_modules/node-pty/build/Release/spawn-helper'),
  ]) {
    const target = await realpath(helper).catch(() => undefined);
    if (target) await chmod(target, 0o755);
  }
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Native preparation failed (${code ?? signal ?? 'unknown'})`));
    });
  });
}
