import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  desktopPackageIdentity,
  packageIdentity,
} from '../../scripts/desktop-package-identity.mjs';
import { packageOptions } from '../../scripts/package-desktop.mjs';
import { resolveLevel3PackagedArtifact } from '../../scripts/level3-artifact.mjs';
import { writeInstalledLevel3Result } from '../../scripts/level3-installed-result.mjs';
import { resolveLegacyShellSource } from '../../apps/desktop/src/shell/home-policy.ts';

it('requires an explicit product selection and rejects unknown or mixed artifact identities', async () => {
  expect(packageIdentity().migrationValidation).toBe(true);
  const product = packageIdentity(true);
  expect(product).toMatchObject({
    name: 'axterm',
    productName: 'Axterm',
    appId: 'dev.axterm.desktop',
    productCutover: true,
    migrationValidation: false,
  });
  expect(Object.isFrozen(product)).toBe(true);
  expect(() => packageIdentity('true' as never)).toThrow('mode');
  expect(await packageOptions([])).toMatchObject({ product: false });
  expect(await packageOptions(['--product', '--dir'])).toMatchObject({
    product: true,
    directoryOnly: true,
  });
  await expect(packageOptions(['--product', '--product'])).rejects.toThrow('repeated');
  for (const record of [
    { purpose: 'migration-validation', productCutover: true },
    { purpose: 'desktop-application', productCutover: false },
    { purpose: 'unknown', productCutover: true },
  ])
    expect(() => desktopPackageIdentity(record)).toThrow('identity');
  expect(() =>
    desktopPackageIdentity(product, {
      name: 'axterm',
      main: 'lib/shell/main.js',
      axterm: { migrationValidation: true },
    }),
  ).toThrow('identity');
  expect(() =>
    desktopPackageIdentity(product, {
      name: 'old-app',
      main: 'lib/shell/main.js',
      axterm: { migrationValidation: false },
    }),
  ).toThrow('identity');
});

it.each(['darwin', 'win32', 'linux'] as const)(
  'binds a relocated product artifact to the same production identity on %s',
  async (platform) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-product-artifact-')));
    try {
      const bundle = join(root, platform === 'darwin' ? 'Axterm.app' : 'Axterm');
      const app = join(bundle, platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app');
      const bin = platform === 'darwin' ? join(bundle, 'Contents/MacOS') : bundle;
      await mkdir(join(app, 'lib/shell'), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(app, 'lib/shell/main.js'), '// fixture only');
      await writeFile(
        join(
          bin,
          platform === 'win32' ? 'Axterm.exe' : platform === 'darwin' ? 'Axterm' : 'axterm',
        ),
        'fixture only',
      );
      const inventory = { purpose: 'desktop-application', productCutover: true, platform };
      await writeFile(join(app, 'LEVEL3_PACKAGE.json'), JSON.stringify(inventory));
      await writeFile(
        join(app, 'package.json'),
        JSON.stringify({
          name: 'axterm',
          main: 'lib/shell/main.js',
          axterm: { migrationValidation: false },
        }),
      );
      const result = await resolveLevel3PackagedArtifact({ candidate: bundle }, platform);
      expect(result?.appDirectory).toBe(app);
      if (platform === process.platform) {
        const record = join(root, 'installed.json');
        await writeInstalledLevel3Result(bundle, record);
        expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({
          purpose: inventory.purpose,
          productCutover: true,
          app,
        });
        await expect(writeInstalledLevel3Result(bundle, record)).rejects.toMatchObject({
          code: 'EEXIST',
        });
      }
      const resultFile = join(root, 'mismatched.json');
      await writeFile(
        resultFile,
        JSON.stringify({ purpose: 'migration-validation', productCutover: false, app }),
      );
      await expect(resolveLevel3PackagedArtifact({ result: resultFile }, platform)).rejects.toThrow(
        'candidate',
      );
      await writeFile(
        join(app, 'LEVEL3_PACKAGE.json'),
        JSON.stringify({ ...inventory, productCutover: false }),
      );
      await expect(resolveLevel3PackagedArtifact({ candidate: bundle }, platform)).rejects.toThrow(
        'identity',
      );
      expect(dirname(app)).toBe(result?.resourcesDirectory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('never discovers a legacy source in development or validation and bounds explicit product sources', () => {
  const source = join(tmpdir(), 'private-legacy'),
    fallback = join(tmpdir(), 'native-appdata', 'Axterm');
  expect(resolveLegacyShellSource(source, false, false, fallback)).toBeUndefined();
  expect(resolveLegacyShellSource(source, true, true, fallback)).toBeUndefined();
  expect(resolveLegacyShellSource(undefined, true, false, fallback)).toBe(fallback);
  expect(resolveLegacyShellSource(source, true, false, fallback)).toBe(source);
  expect(() => resolveLegacyShellSource('relative', true, false, fallback)).toThrow('ABSOLUTE');
  expect(() => resolveLegacyShellSource('/tmp/invalid\0source', true, false, fallback)).toThrow(
    'ABSOLUTE',
  );
});
