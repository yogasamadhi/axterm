import { desktopPackageIdentity } from './desktop-package-identity.mjs';
import { assertElectronLocaleFamilies } from './electron-locale-families.mjs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
  glob,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'));

/** Junctions use absolute targets on Windows; relocate them and verify the copied closure. */
export async function relocateRuntimeLinks(source, destination) {
  source = await realpath(source);
  destination = await realpath(destination);
  const inside = (parent, path) => path === parent || path.startsWith(parent + sep);
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (inside(source, target)) {
          const relocated = join(destination, relative(source, target));
          await unlink(path);
          await symlink(
            process.platform === 'win32' ? relocated : relative(dirname(path), relocated),
            path,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        if (!inside(destination, await realpath(path)))
          throw new Error('Packaged dependency escaped the runtime closure');
      } else if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(destination);
}

/** Directory-only engineering artifact; never publishes or discovers signing credentials. */
export async function packageLevel3Desktop(stage, output) {
  for (const path of [stage, output]) {
    if (
      !isAbsolute(path) ||
      !(await lstat(path)).isDirectory() ||
      (await lstat(path)).isSymbolicLink()
    )
      throw new Error('Package inputs require absolute non-symlink directories');
  }
  stage = await realpath(stage);
  output = await realpath(output);
  if ((await readdir(output)).length) throw new Error('Package output must be empty');
  if (stage === output || stage.startsWith(output + sep) || output.startsWith(stage + sep))
    throw new Error('Package input and output cannot contain one another');
  const inventory = JSON.parse(await readFile(join(stage, 'LEVEL3_PACKAGE.json'), 'utf8'));
  const identity = desktopPackageIdentity(inventory);
  const native = inventory.nativePreparation;
  if (
    !native ||
    native.electron !== inventory.electron ||
    native.platform !== process.platform ||
    native.arch !== process.arch ||
    native.modules?.length !== 2 ||
    !['node-pty', '@serialport/bindings-cpp'].every((name) => native.modules.includes(name)) ||
    native.files?.length < 2 ||
    !native.files?.length
  )
    throw new Error('Stage requires native preparation for this Electron/platform');
  for (const file of native.files) {
    const path = resolve(stage, file.path);
    if (
      !path.startsWith(stage + sep) ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== file.sha256
    )
      throw new Error('Prepared native artifact is missing or changed');
  }
  const carrier = join(output, 'carrier');
  await mkdir(carrier);
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  desktopPackageIdentity(inventory, manifest);
  await writeFile(
    join(carrier, 'package.json'),
    JSON.stringify({
      ...manifest,
      dependencies: {},
      main: 'entry.cjs',
    }),
  );
  await writeFile(
    join(carrier, 'entry.cjs'),
    "throw new Error('MIGRATION_PACKAGE_ASSEMBLY_INCOMPLETE');\n",
  );
  const { build } = desktopRequire('electron-builder');
  // The complete already-resolved closure is copied below. A second dependency
  // collector must not flatten peer instances or omit optional/dynamic graph chunks.
  const previous = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  try {
    await build({
      projectDir: carrier,
      publish: 'never',
      dir: true,
      config: {
        appId: identity.appId,
        productName: identity.productName,
        electronVersion: inventory.electron,
        electronDist: join(dirname(desktopRequire.resolve('electron/package.json')), 'dist'),
        directories: { app: carrier, output: join(output, 'artifact') },
        asar: false,
        npmRebuild: false,
        protocols: [
          {
            name: 'Axterm session link',
            schemes: ['axterm', 'ssh', 'telnet', 'vnc', 'rdp', 'spice', 'serial', 'ftp'],
          },
        ],
        electronLanguages: ['en', 'ja', 'zh-CN', 'zh-TW'],
        files: ['entry.cjs', 'package.json'],
        mac: { identity: null, icon: join(stage, 'build/icon.icns'), target: 'dir' },
        win: { icon: join(stage, 'build/icon.ico'), signAndEditExecutable: false, target: 'dir' },
        linux: {
          executableName: identity.executableName,
          icon: join(stage, 'build/icon.png'),
          target: 'dir',
        },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previous;
  }
  const locations = [];
  for await (const path of glob('**/resources/app/package.json', { cwd: join(output, 'artifact') }))
    locations.push(path);
  for await (const path of glob('**/Resources/app/package.json', { cwd: join(output, 'artifact') }))
    locations.push(path);
  if (locations.length !== 1) throw new Error('Cannot identify the packaged application directory');
  const app = dirname(join(output, 'artifact', locations[0]));
  const resources = dirname(app);
  await assertElectronLocaleFamilies(
    process.platform === 'darwin' ? dirname(dirname(resources)) : dirname(resources),
  );
  await cp(stage, app, { recursive: true, verbatimSymlinks: true });
  await relocateRuntimeLinks(stage, app);
  await cp(join(stage, 'AXTERM_UPDATE_FEED.json'), join(dirname(app), 'AXTERM_UPDATE_FEED.json'));
  if (process.platform === 'linux')
    await cp(join(stage, 'build/icon.png'), join(dirname(app), 'axterm-icon.png'));
  const legalDirectory = dirname(dirname(app));
  const electronDist = join(dirname(desktopRequire.resolve('electron/package.json')), 'dist');
  for (const [source, target] of [
    ['LICENSE', 'LICENSE.electron.txt'],
    ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
  ])
    await cp(join(electronDist, source), join(legalDirectory, target));
  for (const [source, target] of [
    ['LICENSE', 'LICENSE.axterm'],
    ...[
      'THIRD_PARTY_NOTICES.txt',
      'THIRD_PARTY_COMPONENTS.json',
      'THIRD_PARTY_LICENSE_TEXTS.json',
      'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
      'licenses',
    ].map((name) => [name, name]),
  ])
    await cp(join(stage, source), join(legalDirectory, target), { recursive: true });
  await writeFile(
    join(output, 'LEVEL3_PACKAGE_RESULT.json'),
    JSON.stringify(
      {
        purpose: identity.purpose,
        productCutover: identity.productCutover,
        app,
        inventory,
      },
      null,
      2,
    ) + '\n',
  );
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node scripts/package-level3-desktop.mjs <absolute-prepared-stage> <absolute-empty-output>',
    );
  console.info(
    `Packaged migration application at ${await packageLevel3Desktop(process.argv[2], process.argv[3])}`,
  );
}
