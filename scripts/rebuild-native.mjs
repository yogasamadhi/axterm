import { resolve } from 'node:path';
import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { rebuild } from '@electron/rebuild';

/** @param {string} nodePtyRoot */
export async function removeNodeAbiMarkers(nodePtyRoot) {
  const buildDirectory = resolve(nodePtyRoot, 'build');
  const entries = await readdir(buildDirectory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('.axterm-node-'))
      .map((entry) => rm(resolve(buildDirectory, entry), { force: true })),
  );
}

/** @param {{ appDir: string, electronVersion: string, platform: string, arch: string }} context */
export default async function rebuildNative(context) {
  await rebuild({
    buildPath: context.appDir,
    projectRootPath: resolve(import.meta.dirname, '..'),
    electronVersion: context.electronVersion,
    platform: context.platform,
    arch: context.arch,
    onlyModules: ['node-pty', '@serialport/bindings-cpp'],
    force: true,
  });

  // @electron/rebuild replaces the shared workspace binary with an Electron-ABI build.
  // Remove the development marker so the next install/prepare step cannot mistake that
  // binary for the current Node ABI.
  const nodePtyRoot = await realpath(resolve(context.appDir, 'node_modules/node-pty')).catch(
    () => undefined,
  );
  if (nodePtyRoot) await removeNodeAbiMarkers(nodePtyRoot);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..');
  const desktopPackage = JSON.parse(
    await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'),
  );
  await rebuildNative({
    appDir: resolve(root, 'apps/desktop'),
    electronVersion: desktopPackage.devDependencies.electron,
    platform: process.platform,
    arch: process.arch,
  });
}
