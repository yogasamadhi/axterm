import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  packagedArtifactSbomFromInventory,
  serializePackagedArtifactSbom,
} from '../../scripts/commercialization/generate-packaged-artifact-sbom.mjs';
import {
  packagedArtifactVerificationReceipt,
  verifyPackagedArtifactSbomFromInventory,
} from '../../scripts/commercialization/verify-packaged-artifact-sbom.mjs';

const hash = (character: string) => character.repeat(64);

describe('packaged artifact SPDX sidecar', () => {
  it('maps one concrete package inventory without treating it as source-rights clearance', () => {
    const inventory = {
      archiveSha256: hash('a'),
      archiveArtifactPath: 'Resources/app.asar',
      packages: [
        {
          name: '@scope/component',
          version: '1.2.3',
          manifestPath: '/node_modules/@scope/component/package.json',
          licenseSource: 'license',
          licenseDeclarations: ['MIT OR Apache-2.0'],
        },
        {
          name: '@workspace/runtime',
          version: '0.10.0',
          manifestPath: '/node_modules/@workspace/runtime/package.json',
          licenseSource: null,
          licenseDeclarations: [],
        },
      ],
      rendererAssetFiles: [
        { path: '/out/renderer/assets/main.js', sha256: hash('b') },
        { path: '/out/renderer/assets/font.woff2', sha256: hash('1') },
        { path: '/out/renderer/assets/icon.png', sha256: hash('2') },
      ],
      rendererProvenanceFiles: [
        { path: '/out/renderer/axterm-novnc-bundle-provenance.json', sha256: hash('f') },
        { path: '/out/renderer/axterm-spice-client-bundle-provenance.json', sha256: hash('8') },
      ],
      unpackedFiles: [
        { artifactPath: 'Resources/app.asar.unpacked/addon.node', sha256: hash('c') },
      ],
      externalLegalFiles: [
        { artifactPath: 'LICENSE.axterm', sha256: hash('d') },
        { artifactPath: 'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json', sha256: hash('9') },
        { artifactPath: 'licenses/spice-client-1.2.0-source.tar', sha256: hash('6') },
        { artifactPath: 'licenses/noVNC-1.7.0-source.tgz', sha256: hash('5') },
      ],
      electronRuntimeLegalFiles: [{ path: 'LICENSES.chromium.html', sha256: hash('e') }],
    };

    const first = packagedArtifactSbomFromInventory(
      inventory,
      { name: 'axterm', version: '0.10.0' },
      'macos-arm64',
    );
    const second = packagedArtifactSbomFromInventory(
      inventory,
      { name: 'axterm', version: '0.10.0' },
      'macos-arm64',
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      documentNamespace: expect.stringContaining('/macos-arm64/'),
      comment: expect.stringContaining('not a complete source-to-binary map'),
    });
    expect(first.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'axterm packaged artifact' }),
        expect.objectContaining({
          name: '@scope/component',
          externalRefs: [
            expect.objectContaining({ referenceLocator: 'pkg:npm/%40scope/component@1.2.3' }),
          ],
          licenseComments: 'Packaged manifest license declaration: MIT OR Apache-2.0',
        }),
      ]),
    );
    expect(
      first.packages.find((entry: { name: string }) => entry.name === '@workspace/runtime'),
    ).toBeUndefined();
    expect(first.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileName: './Resources/app.asar',
          fileTypes: ['ARCHIVE'],
          checksums: expect.arrayContaining([
            expect.objectContaining({ checksumValue: hash('a') }),
          ]),
        }),
        expect.objectContaining({
          fileName: './Resources/app.asar/out/renderer/assets/main.js',
          fileTypes: ['TEXT'],
        }),
        expect.objectContaining({
          fileName: './Resources/app.asar/out/renderer/assets/font.woff2',
          fileTypes: ['BINARY'],
        }),
        expect.objectContaining({
          fileName: './Resources/app.asar/out/renderer/assets/icon.png',
          fileTypes: ['IMAGE'],
        }),
        expect.objectContaining({
          fileName: './Resources/app.asar/out/renderer/axterm-novnc-bundle-provenance.json',
          fileTypes: ['TEXT'],
          checksums: expect.arrayContaining([
            expect.objectContaining({ checksumValue: hash('f') }),
          ]),
        }),
        expect.objectContaining({ fileName: './Resources/app.asar.unpacked/addon.node' }),
        expect.objectContaining({
          fileName: './Resources/app.asar/out/renderer/axterm-spice-client-bundle-provenance.json',
          fileTypes: ['TEXT'],
          checksums: expect.arrayContaining([
            expect.objectContaining({ checksumValue: hash('8') }),
          ]),
        }),
        expect.objectContaining({ fileName: './LICENSE.axterm', fileTypes: ['TEXT'] }),
        expect.objectContaining({
          fileName: './licenses/spice-client-1.2.0-source.tar',
          fileTypes: ['ARCHIVE'],
          checksums: expect.arrayContaining([
            expect.objectContaining({ checksumValue: hash('6') }),
          ]),
        }),
        expect.objectContaining({
          fileName: './licenses/noVNC-1.7.0-source.tgz',
          fileTypes: ['ARCHIVE'],
          checksums: expect.arrayContaining([
            expect.objectContaining({ checksumValue: hash('5') }),
          ]),
        }),
        expect.objectContaining({
          fileName: './AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
          fileTypes: ['SPDX', 'TEXT'],
        }),
        expect.objectContaining({ fileName: './LICENSES.chromium.html', fileTypes: ['TEXT'] }),
      ]),
    );
  });

  it('rejects an unsafe platform label and invalid artifact-relative path', () => {
    const inventory = {
      archiveSha256: hash('a'),
      archiveArtifactPath: '../app.asar',
      packages: [],
      rendererAssetFiles: [],
      unpackedFiles: [],
      externalLegalFiles: [],
      electronRuntimeLegalFiles: [],
    };
    expect(() =>
      packagedArtifactSbomFromInventory(inventory, { name: 'axterm', version: '0.10.0' }, '../bad'),
    ).toThrow('Invalid platform identifier');
    expect(() =>
      packagedArtifactSbomFromInventory(
        inventory,
        { name: 'axterm', version: '0.10.0' },
        'linux-x64',
      ),
    ).toThrow('Invalid artifact-relative path');
  });

  it('rejects a stale sidecar after packaged bytes or the platform identity change', async () => {
    const inventory = {
      archiveSha256: hash('a'),
      archiveArtifactPath: 'Resources/app.asar',
      packages: [],
      rendererAssetFiles: [],
      rendererProvenanceFiles: [
        { path: '/out/renderer/axterm-novnc-bundle-provenance.json', sha256: hash('f') },
        { path: '/out/renderer/axterm-spice-client-bundle-provenance.json', sha256: hash('8') },
      ],
      unpackedFiles: [],
      externalLegalFiles: [{ artifactPath: 'THIRD_PARTY_NOTICES.txt', sha256: hash('b') }],
      electronRuntimeLegalFiles: [],
    };
    const product = { name: 'axterm', version: '0.10.0' };
    const sidecar = await serializePackagedArtifactSbom(
      packagedArtifactSbomFromInventory(inventory, product, 'macos-arm64'),
    );
    const verified = await verifyPackagedArtifactSbomFromInventory(
      inventory,
      product,
      'macos-arm64',
      sidecar,
    );
    expect(verified.archiveSha256).toBe(hash('a'));
    expect(
      packagedArtifactVerificationReceipt(
        '/artifact/AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json',
        sidecar,
        verified,
        product,
        'macos-arm64',
      ),
    ).toMatchObject({
      verification: 'packaged-spdx-byte-verification',
      platform: 'macos-arm64',
      sidecar: {
        path: 'AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json',
        bytes: Buffer.byteLength(sidecar),
        sha256: createHash('sha256').update(sidecar).digest('hex'),
      },
      appAsarSha256: hash('a'),
    });
    await expect(
      verifyPackagedArtifactSbomFromInventory(
        { ...inventory, archiveSha256: hash('c') },
        product,
        'macos-arm64',
        sidecar,
      ),
    ).rejects.toThrow('does not match macos-arm64 app resources');
    await expect(
      verifyPackagedArtifactSbomFromInventory(
        {
          ...inventory,
          externalLegalFiles: [{ artifactPath: 'THIRD_PARTY_NOTICES.txt', sha256: hash('c') }],
        },
        product,
        'macos-arm64',
        sidecar,
      ),
    ).rejects.toThrow('does not match macos-arm64 app resources');
    await expect(
      verifyPackagedArtifactSbomFromInventory(
        {
          ...inventory,
          rendererProvenanceFiles: [
            { path: '/out/renderer/axterm-novnc-bundle-provenance.json', sha256: hash('e') },
            { path: '/out/renderer/axterm-spice-client-bundle-provenance.json', sha256: hash('8') },
          ],
        },
        product,
        'macos-arm64',
        sidecar,
      ),
    ).rejects.toThrow('does not match macos-arm64 app resources');
    await expect(
      verifyPackagedArtifactSbomFromInventory(
        {
          ...inventory,
          rendererProvenanceFiles: [
            { path: '/out/renderer/axterm-novnc-bundle-provenance.json', sha256: hash('f') },
            { path: '/out/renderer/axterm-spice-client-bundle-provenance.json', sha256: hash('7') },
          ],
        },
        product,
        'macos-arm64',
        sidecar,
      ),
    ).rejects.toThrow('does not match macos-arm64 app resources');
    await expect(
      verifyPackagedArtifactSbomFromInventory(inventory, product, 'windows-x64', sidecar),
    ).rejects.toThrow('does not match windows-x64 app resources');
  });

  it('requires a platform-specific sidecar after every CI package build', () => {
    const workflow = readFileSync(resolve('.github/workflows/check.yml'), 'utf8');
    expect(workflow).toContain(
      'release/mac-arm64/Axterm.app/Contents/Resources --platform macos-arm64',
    );
    expect(workflow).toContain('release/win-unpacked/resources --platform windows-x64');
    expect(workflow).toContain('release/linux-unpacked/resources --platform linux-x64');
    expect(workflow).toContain('name: packaged-sbom-${{ matrix.os }}');
    for (const platform of ['macos-arm64', 'windows-x64', 'linux-x64']) {
      expect(workflow).toContain(
        `--platform ${platform} --sidecar release/AXTERM_PACKAGED_ARTIFACTS.${platform}.spdx.json`,
      );
    }
    expect(workflow.indexOf('bun run sbom:packaged:check')).toBeGreaterThan(
      workflow.indexOf('run: bun run test:dmg:macos'),
    );
    expect(workflow.indexOf('bun run sbom:packaged:check')).toBeLessThan(
      workflow.indexOf('uses: actions/upload-artifact'),
    );
  });
});
