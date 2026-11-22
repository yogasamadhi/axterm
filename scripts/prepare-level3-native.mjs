import { desktopPackageIdentity } from './desktop-package-identity.mjs';
import { chmod, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rebuild } from '@electron/rebuild';

/** Rebuild copied native inputs; reject a link back into a development package/store. */
export async function prepareLevel3Native(directory) {
  if (!isAbsolute(directory)) throw new Error('Native preparation requires an absolute stage');
  const stage = await realpath(directory);
  const inventory = JSON.parse(await readFile(join(stage, 'LEVEL3_PACKAGE.json'), 'utf8'));
  try {
    desktopPackageIdentity(inventory);
  } catch {
    throw new Error('Native stage identity or platform mismatch');
  }
  if (
    inventory.electron !== '44.3.0' ||
    inventory.platform !== process.platform ||
    inventory.arch !== process.arch
  )
    throw new Error('Native stage identity or platform mismatch');
  const modules = [];
  for (const name of ['node-pty', '@serialport/bindings-cpp']) {
    const path = await realpath(join(stage, 'node_modules', name));
    if (!path.startsWith(stage + sep))
      throw new Error('Native package is outside the isolated stage');
    modules.push({ name, path });
  }
  await rebuild({
    buildPath: stage,
    projectRootPath: stage,
    electronVersion: inventory.electron,
    onlyModules: modules.map(({ name }) => name),
    force: true,
    buildFromSource: true,
  });
  const files = [];
  for (const native of modules) {
    const release = join(native.path, 'build/Release');
    for (const name of await readdir(join(native.path, 'build'))) {
      if (name.startsWith('.axterm-node-')) await rm(join(native.path, 'build', name));
    }
    const runtimeFiles = [];
    if (native.name === 'node-pty') {
      if (process.platform === 'win32') {
        // electron-rebuild runs node-gyp directly. The pinned postinstall places ConPTY beside it.
        await promisify(execFile)(
          process.execPath,
          [join(native.path, 'scripts/post-install.js')],
          {
            cwd: native.path,
            env: { ...process.env, npm_config_arch: process.arch },
            windowsHide: true,
          },
        );
        runtimeFiles.push('conpty/conpty.dll', 'conpty/OpenConsole.exe');
      } else await chmod(join(release, 'spawn-helper'), 0o755);
    }
    const addons = (await readdir(release)).filter((name) => name.endsWith('.node')).sort();
    if (!addons.length) throw new Error('Native rebuild produced no addon for ' + native.name);
    for (const name of [...addons, ...runtimeFiles]) {
      const path = join(release, name);
      files.push({
        path: relative(stage, path).split(sep).join('/'),
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
    }
    await rm(join(native.path, 'prebuilds'), { recursive: true, force: true });
    await rm(join(native.path, 'build/Release/obj.target'), { recursive: true, force: true });
    if (native.name === 'node-pty' && process.platform !== 'win32')
      await rm(join(native.path, 'third_party/conpty'), { recursive: true, force: true });
  }
  inventory.nativePreparation = {
    electron: inventory.electron,
    platform: process.platform,
    arch: process.arch,
    modules: modules.map(({ name }) => name),
    files,
  };
  await writeFile(join(stage, 'LEVEL3_PACKAGE.json'), JSON.stringify(inventory, null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/prepare-level3-native.mjs <absolute-stage>');
  await prepareLevel3Native(process.argv[2]);
  console.info(
    'Prepared isolated Electron native PTY and SerialPort without changing the development store.',
  );
}
