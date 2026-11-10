import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { desktopDevelopmentLaunch } from '../../scripts/dev-desktop.mjs';
import { inspectBuiltDesktopModule } from '../../scripts/packaging-check.mjs';
import { packageLevel3Installers } from '../../scripts/package-level3-installers.mjs';
import { level3CiArtifacts } from '../../scripts/level3-ci-artifacts.mjs';
import { writeInstalledLevel3Result } from '../../scripts/level3-installed-result.mjs';

it('launches only the owned Shell in an isolated home and removes inherited Node entry overrides', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-owned-dev-')));
  try {
    for (const name of [
      'apps/desktop/lib/shell/main.js',
      'apps/desktop-host/lib/index.js',
      'apps/web/dist/index.html',
    ]) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), 'fixture only');
    }
    const desktop = join(root, 'apps/desktop');
    await writeFile(join(desktop, 'package.json'), '{}');
    await mkdir(join(desktop, 'node_modules'));
    const electron = dirname(
      createRequire(resolve('apps/desktop/package.json')).resolve('electron'),
    );
    await symlink(electron, join(desktop, 'node_modules/electron'), 'junction');
    const home = join(root, 'private-home'),
      user = join(root, 'user');
    const launch = await desktopDevelopmentLaunch(
      root,
      {
        AXTERM_HOME: home,
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'https://untrusted.invalid',
        NODE_OPTIONS: '--import=untrusted',
        NODE_PATH: '/untrusted',
        ELECTRON_CLI_ARGS: '["--new-window"]',
      },
      user,
    );
    expect(launch.args).toEqual([desktop, '--new-window']);
    expect(launch.env).toMatchObject({
      AXTERM_HOME: home,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_RENDERER_URL: '',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    });
    for (const override of [join(user, '.axterm'), join(user, '.axterm/data-v2')])
      await expect(
        desktopDevelopmentLaunch(root, { AXTERM_HOME: override }, user),
      ).rejects.toThrow();
    for (const args of ['{}', '[42]', '["\\u0000"]'])
      await expect(
        desktopDevelopmentLaunch(root, { AXTERM_HOME: home, ELECTRON_CLI_ARGS: args }, user),
      ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects source-bound built imports while allowing copied JavaScript package boundaries', () => {
  const root = resolve('.');
  for (const source of [
    "import '@workspace/runtime';",
    "import '../src/domain.ts';",
    "export * from 'file:///source.js';",
    "require('/source/host.js');",
    "import('/source/client.js');",
  ])
    expect(inspectBuiltDesktopModule('main.js', source, root).length, source).toBeGreaterThan(0);
  expect(
    inspectBuiltDesktopModule(
      'main.js',
      "import {run} from '@axterm/desktop-host'; import('./owned-chunk.js');",
      root,
    ),
  ).toEqual([]);
});

it('refuses an assembly carrier, changed native closure and escaped native inputs before invoking installer creation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-installer-admission-')));
  try {
    const app = join(root, 'application/resources/app'),
      output = join(root, 'installers');
    await mkdir(app, { recursive: true });
    await mkdir(output);
    await writeFile(join(app, 'package.json'), JSON.stringify({ main: 'entry.cjs' }));
    await writeFile(join(app, 'LEVEL3_PACKAGE.json'), '{}');
    await expect(packageLevel3Installers(app, output)).rejects.toThrow(
      'completed new-architecture',
    );
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ main: 'lib/shell/main.js', axterm: { migrationValidation: true } }),
    );
    const bytes = Buffer.from('reviewed native fixture'),
      hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(app, 'pty.node'), bytes);
    await writeFile(join(app, 'serial.node'), bytes);
    const inventory = {
      purpose: 'migration-validation',
      productCutover: false,
      platform: process.platform,
      arch: process.arch,
      electron: '44.3.0',
      nativePreparation: {
        electron: '44.3.0',
        platform: process.platform,
        arch: process.arch,
        modules: ['node-pty', '@serialport/bindings-cpp'],
        files: [
          { path: 'pty.node', sha256: hash },
          { path: 'serial.node', sha256: '0'.repeat(64) },
        ],
      },
    };
    await writeFile(join(app, 'LEVEL3_PACKAGE.json'), JSON.stringify(inventory));
    await expect(packageLevel3Installers(app, output)).rejects.toThrow('native input changed');
    inventory.nativePreparation.files[1] = { path: '../../outside.node', sha256: hash };
    await writeFile(join(app, 'LEVEL3_PACKAGE.json'), JSON.stringify(inventory));
    await expect(packageLevel3Installers(app, output)).rejects.toThrow('native input changed');
    expect(await readFile(join(app, 'pty.node'))).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses an old installed application and never overwrites an existing result', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-installed-admission-')));
  try {
    const app = join(
      root,
      process.platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app',
    );
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'LEVEL3_PACKAGE.json'), '{}');
    await writeFile(join(app, 'package.json'), '{"main":"out/main/index.js"}');
    const output = join(root, 'result.json');
    await writeFile(output, 'retained-result');
    await expect(writeInstalledLevel3Result(root, output)).rejects.toThrow('new-architecture');
    expect(await readFile(output, 'utf8')).toBe('retained-result');
    await expect(writeInstalledLevel3Result('relative', output)).rejects.toThrow('absolute');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('binds CI and installed journeys to the actual relocated candidate and rejects existing output or escaped distribution files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-ci-admission-')));
  try {
    const candidate = join(root, 'candidate'),
      distribution = join(root, 'distribution');
    const app = join(
      candidate,
      process.platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app',
    );
    const bin = process.platform === 'darwin' ? join(candidate, 'Contents/MacOS') : candidate;
    await mkdir(join(app, 'lib/shell'), { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(distribution);
    await writeFile(join(app, 'lib/shell/main.js'), 'fixture');
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ main: 'lib/shell/main.js', axterm: { migrationValidation: true } }),
    );
    await writeFile(
      join(app, 'LEVEL3_PACKAGE.json'),
      JSON.stringify({
        purpose: 'migration-validation',
        productCutover: false,
        platform: process.platform,
      }),
    );
    await writeFile(
      join(
        bin,
        process.platform === 'win32'
          ? 'Axterm Level3 Validation.exe'
          : process.platform === 'darwin'
            ? 'Axterm Level3 Validation'
            : 'axterm-level3-validation',
      ),
      'fixture',
    );
    if (process.platform === 'win32')
      await writeFile(join(bin, 'Uninstall Axterm Level3 Validation.exe'), 'uninstaller fixture');
    const result = join(root, 'installed-result.json');
    await writeInstalledLevel3Result(candidate, result);
    const bytes = await readFile(result);
    await expect(writeInstalledLevel3Result(candidate, result)).rejects.toThrow('EEXIST');
    expect(await readFile(result)).toEqual(bytes);
    const artifact = join(distribution, 'Axterm-fixture.zip');
    await writeFile(artifact, 'fixture');
    const record = {
      purpose: 'migration-validation',
      productCutover: false,
      app,
      packageResult: result,
      artifacts: [artifact],
    };
    const distributionResult = join(distribution, 'LEVEL3_DISTRIBUTION_RESULT.json');
    await writeFile(distributionResult, JSON.stringify(record));
    expect(await level3CiArtifacts(distribution)).toMatchObject({
      AXTERM_LEVEL3_PACKAGE_RESULT: result,
      AXTERM_CI_RESOURCES: dirname(app),
      AXTERM_ARTIFACT_DIR: distribution,
    });
    await writeFile(distributionResult, JSON.stringify({ ...record, artifacts: [result] }));
    await expect(level3CiArtifacts(distribution)).rejects.toThrow('escaped');
    await writeFile(distributionResult, JSON.stringify({ ...record, app: root }));
    await expect(level3CiArtifacts(distribution)).rejects.toThrow('differs');
    await writeFile(distributionResult, JSON.stringify({ ...record, productCutover: true }));
    await expect(level3CiArtifacts(distribution)).rejects.toThrow('completed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
