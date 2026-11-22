import { desktopPackageIdentity } from './desktop-package-identity.mjs';
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const desktop = join(root, 'apps/desktop');

/** NSIS dereferences junctions. Restore the relative dependency graph after extraction. */
export async function prepareWindowsInstallerInput(prepackaged, destination) {
  const app = join(prepackaged, 'resources', 'app');
  const packages = join(app, 'node_modules') + sep;
  const instances = join(packages, '.axterm') + sep;
  const links = [];
  await cp(prepackaged, destination, {
    recursive: true,
    async filter(path) {
      if (!(await lstat(path)).isSymbolicLink()) return true;
      const target = await realpath(path);
      if (!path.startsWith(packages) || !target.startsWith(instances))
        throw Error('Windows installer junction escaped the runtime dependency graph');
      links.push([relative(app, path), relative(app, target)]);
      return false;
    },
  });
  const resources = join(destination, 'resources');
  await writeFile(join(resources, 'axterm-runtime-links.json'), JSON.stringify(links.sort()));
  await cp(
    join(desktop, 'build/restore-runtime-links.mjs'),
    join(resources, 'axterm-restore-runtime-links.mjs'),
  );
}

/** Distributable formats consume the completed runtime closure, never the assembly carrier. */
export async function packageLevel3Installers(app, output) {
  if (!isAbsolute(app) || !isAbsolute(output)) throw Error('Installer paths must be absolute');
  for (const path of [app, output]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error('Installer paths must be real directories');
  }
  app = await realpath(app);
  output = await realpath(output);
  if ((await readdir(output)).length) throw Error('Installer output must be empty');
  const inventory = JSON.parse(await readFile(join(app, 'LEVEL3_PACKAGE.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
  let identity;
  try {
    identity = desktopPackageIdentity(inventory, manifest);
  } catch {
    throw Error('Installers require a completed new-architecture application');
  }
  if (
    inventory.platform !== process.platform ||
    inventory.arch !== process.arch ||
    manifest.main !== 'lib/shell/main.js' ||
    inventory.nativePreparation?.electron !== inventory.electron ||
    inventory.nativePreparation?.platform !== process.platform ||
    inventory.nativePreparation?.arch !== process.arch ||
    !Array.isArray(inventory.nativePreparation?.files) ||
    inventory.nativePreparation.files.length < 2 ||
    inventory.nativePreparation?.modules?.length !== 2 ||
    !['node-pty', '@serialport/bindings-cpp'].every((name) =>
      inventory.nativePreparation.modules.includes(name),
    )
  )
    throw Error('Installers require a completed new-architecture application');
  for (const file of inventory.nativePreparation.files ?? []) {
    const path = resolve(app, file.path);
    if (
      !path.startsWith(app + sep) ||
      !(await realpath(path)).startsWith(app + sep) ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== file.sha256
    )
      throw Error('Prepared native input changed before installer creation');
  }
  const prepackaged =
    process.platform === 'darwin' ? dirname(dirname(dirname(app))) : dirname(dirname(app));
  if (
    output === prepackaged ||
    output.startsWith(prepackaged + sep) ||
    prepackaged.startsWith(output + sep)
  )
    throw Error('Installer output and application cannot contain one another');
  const { build } = createRequire(join(desktop, 'package.json'))('electron-builder');
  const discovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  const windowsInput =
    process.platform === 'win32' ? await mkdtemp(join(dirname(prepackaged), 'nsis-input-')) : null;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  try {
    if (windowsInput) await prepareWindowsInstallerInput(prepackaged, windowsInput);
    return await build({
      projectDir: desktop,
      prepackaged: windowsInput ?? prepackaged,
      publish: 'never',
      config: {
        extends: join(desktop, 'electron-builder.yml'),
        appId: identity.appId,
        productName: identity.productName,
        linux: { executableName: identity.executableName },
        electronVersion: inventory.electron,
        directories: { output },
        ...(windowsInput ? { nsis: { include: join(desktop, 'build/installer.nsh') } } : {}),
      },
    });
  } finally {
    if (discovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    else process.env.CSC_IDENTITY_AUTO_DISCOVERY = discovery;
    if (windowsInput) await rm(windowsInput, { recursive: true, force: true });
  }
}
