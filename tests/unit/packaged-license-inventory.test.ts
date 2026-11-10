import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inventoryAsarFiles,
  inventoryElectronRuntimeLegalFiles,
  inventoryExternalLegalFiles,
} from '../../scripts/commercialization/packaged-license-inventory.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('packaged license inventory', () => {
  it('finds extraFiles at the artifact root instead of inside resources', () => {
    const artifact = mkdtempSync(join(tmpdir(), 'axterm-external-legal-'));
    temporaryDirectories.push(artifact);
    const resources = join(artifact, 'resources');
    mkdirSync(resources);
    writeFileSync(join(artifact, 'THIRD_PARTY_COMPONENTS.json'), '{"components":[]}');

    expect(inventoryExternalLegalFiles(artifact, artifact)).toContainEqual({
      path: 'THIRD_PARTY_COMPONENTS.json',
      artifactPath: 'THIRD_PARTY_COMPONENTS.json',
      sha256: createHash('sha256').update('{"components":[]}').digest('hex'),
    });
    expect(inventoryExternalLegalFiles(resources, artifact)).toEqual([]);
  });

  it('counts nested package instances and hashes notices from the archive', () => {
    const contents = new Map([
      [
        '/node_modules/example/package.json',
        '{"name":"example","version":"1.0.0","license":"MIT"}',
      ],
      ['/node_modules/example/LICENSE', 'Example copyright notice'],
      [
        '/node_modules/example/node_modules/nested/package.json',
        '{"name":"nested","version":"2.0.0"}',
      ],
      [
        '/node_modules/legacy/package.json',
        '{"name":"legacy","version":"0.0.7","licenses":[{"type":"MIT","url":"https://example.invalid/LICENSE"}]}',
      ],
      ['/node_modules/legacy/LICENSE', 'Copyright Brian White. All rights reserved.'],
      [
        '/node_modules/multiple/package.json',
        '{"name":"multiple","version":"1.0.0","licenses":[{"type":"MIT"},{"type":"BSD-3-Clause"}]}',
      ],
      [
        '/node_modules/@workspace/client/package.json',
        '{"name":"@workspace/client","version":"0.10.0"}',
      ],
      ['/out/renderer/assets/example.js', 'compiled'],
      ['/out/renderer/axterm-novnc-bundle-provenance.json', '{"sources":[]}'],
      ['/out/renderer/axterm-spice-client-bundle-provenance.json', '{"sources":[1]}'],
    ]);
    const files = [...contents.keys()];
    const report = inventoryAsarFiles(files, (path: string) =>
      Buffer.from(contents.get(path) ?? ''),
    );

    expect(report.packageInstances).toBe(5);
    expect(report.uniquePackages).toBe(5);
    expect(report.missingLicenseMetadata).toEqual([
      '/node_modules/example/node_modules/nested/package.json',
    ]);
    expect(report.missingRootLicenseFiles).toEqual([
      '/node_modules/example/node_modules/nested/package.json',
      '/node_modules/multiple/package.json',
    ]);
    expect(report.rendererAssets).toEqual(['/out/renderer/assets/example.js']);
    expect(report.rendererProvenanceFiles).toEqual([
      {
        path: '/out/renderer/axterm-novnc-bundle-provenance.json',
        sha256: createHash('sha256').update('{"sources":[]}').digest('hex'),
      },
      {
        path: '/out/renderer/axterm-spice-client-bundle-provenance.json',
        sha256: createHash('sha256').update('{"sources":[1]}').digest('hex'),
      },
    ]);
    expect(report.packages.find((item: { name: string }) => item.name === 'legacy')).toMatchObject({
      license: 'MIT',
      licenseSource: 'licenses',
      licenseDeclarations: ['MIT'],
    });
    expect(
      report.packages.find((item: { name: string }) => item.name === 'multiple'),
    ).toMatchObject({
      license: null,
      licenseSource: 'licenses',
      licenseDeclarations: ['MIT', 'BSD-3-Clause'],
    });
    expect(
      report.packages.find((item: { name: string }) => item.name === 'example')?.licenseFiles,
    ).toEqual([
      {
        path: '/node_modules/example/LICENSE',
        sha256: '4e1f6d4d07bba17167a1b206b5e78d415636d0b9c4c2bc1b4234393df961c6e5',
      },
    ]);
  });

  it('records Electron and Chromium runtime legal materials without treating them as Axterm extra resources', () => {
    const artifact = mkdtempSync(join(tmpdir(), 'axterm-electron-runtime-legal-'));
    temporaryDirectories.push(artifact);
    const resources = join(artifact, 'Resources');
    mkdirSync(resources);
    const electron = 'Electron MIT text';
    const chromium = '<html>Chromium notices</html>';
    writeFileSync(join(resources, 'LICENSE.electron.txt'), electron);
    writeFileSync(join(artifact, 'LICENSES.chromium.html'), chromium);

    expect(inventoryElectronRuntimeLegalFiles(resources, artifact)).toEqual([
      {
        path: 'LICENSES.chromium.html',
        sourceName: 'LICENSES.chromium.html',
        sha256: createHash('sha256').update(chromium).digest('hex'),
      },
      {
        path: 'Resources/LICENSE.electron.txt',
        sourceName: 'LICENSE',
        sha256: createHash('sha256').update(electron).digest('hex'),
      },
    ]);
  });
});
