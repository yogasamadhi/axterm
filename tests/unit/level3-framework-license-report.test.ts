import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { frameworkLicenseReport } from '../../scripts/commercialization/framework-license-report.mjs';
import { frameworkNames } from '../../scripts/dsh-framework.mjs';
import { licenseTextsFromLicenseReport } from '../../scripts/commercialization/generate-license-texts.mjs';

it('includes all nine original framework identities and license bytes using exact allowed paths, and rejects unpinned changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-framework-license-'));
  try {
    await mkdir(join(root, 'compliance'));
    await cp(
      resolve('compliance/DSH_FRAMEWORK_SOURCE.json'),
      join(root, 'compliance/DSH_FRAMEWORK_SOURCE.json'),
    );
    for (const name of frameworkNames) {
      await mkdir(join(root, 'packages/framework', name), { recursive: true });
      for (const file of ['package.json', 'LICENSE'])
        await cp(
          resolve('packages/framework', name, file),
          join(root, 'packages/framework', name, file),
        );
    }
    const { report, allowedPackagePaths } = frameworkLicenseReport(root);
    expect(report.MIT).toHaveLength(9);
    expect(allowedPackagePaths.size).toBe(9);
    const installed = join(root, 'installed');
    await mkdir(installed);
    expect(() => licenseTextsFromLicenseReport(report, { allowedRoot: installed })).toThrow(
      'escapes installed graph',
    );
    const archive = licenseTextsFromLicenseReport(report, {
      allowedRoot: installed,
      allowedPackagePaths,
    });
    expect(archive.components).toHaveLength(9);
    expect(
      archive.components.every((component: { files: unknown[] }) => component.files.length === 1),
    ).toBe(true);
    expect(archive.missingRootLicenseFiles).toEqual([]);
    const wrong = new Map(allowedPackagePaths);
    wrong.set('@deepseek-ai/cordis\0wrong-version', join(root, 'packages/framework/cordis'));
    wrong.delete(
      [...wrong.keys()].find(
        (key) => key.startsWith('@deepseek-ai/cordis\0') && !key.endsWith('wrong-version'),
      )!,
    );
    expect(() =>
      licenseTextsFromLicenseReport(report, { allowedRoot: installed, allowedPackagePaths: wrong }),
    ).toThrow('escapes installed graph');
    await writeFile(join(root, 'packages/framework/cordis/LICENSE'), 'changed');
    expect(() => frameworkLicenseReport(root)).toThrow('differs from pinned source');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
