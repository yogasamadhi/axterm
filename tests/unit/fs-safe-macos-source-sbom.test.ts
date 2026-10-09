import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fsSafeMacArtifactViolations,
  fsSafeMacSourceSbom,
  serializeFsSafeMacSourceSbom,
} from '../../scripts/commercialization/generate-fs-safe-macos-source-sbom.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const product = { name: 'axterm', version: '0.10.0' };

describe('macOS fs-safe Cargo source-scope SPDX inventory', () => {
  it('lists all 61 pinned source packages without declaring binary linkage or license choice', async () => {
    const sbom = fsSafeMacSourceSbom(inventory, product);
    expect(sbom.packages).toHaveLength(61);
    expect(
      sbom.packages.every(
        ({ licenseConcluded }: { licenseConcluded: string }) => licenseConcluded === 'NOASSERTION',
      ),
    ).toBe(true);
    expect(sbom.packages).toContainEqual(
      expect.objectContaining({
        name: 'zstd-sys',
        versionInfo: '2.1.0+zstd.1.5.7',
        primaryPackagePurpose: 'SOURCE',
        externalRefs: [
          expect.objectContaining({ referenceLocator: 'pkg:cargo/zstd-sys@2.1.0%2Bzstd.1.5.7' }),
        ],
      }),
    );
    expect(sbom.comment).toContain('does not assert that every package is linked');
    expect(sbom.documentDescribes).toHaveLength(61);
    expect(await serializeFsSafeMacSourceSbom(sbom)).toBe(
      readFileSync(resolve('compliance/AXTERM_FS_SAFE_MACOS_CARGO_SOURCE.spdx.json'), 'utf8'),
    );
  });

  it('rejects changed source scope instead of silently rewriting a review target', () => {
    const changed = structuredClone(inventory);
    changed.packages[0].name = 'different-package';
    expect(fsSafeMacSourceSbom(changed, product).documentNamespace).not.toBe(
      fsSafeMacSourceSbom(inventory, product).documentNamespace,
    );
    changed.packages.push(structuredClone(changed.packages[0]));
    changed.packageCount += 1;
    expect(() => fsSafeMacSourceSbom(changed, product)).toThrow(
      'Unsupported fs-safe macOS source inventory',
    );
  });

  it('compares the concrete native binary, npm identity and legal supplements', () => {
    const legalHashes = {
      'fs-safe-rust-ROOT-LICENSES.txt': '1'.repeat(64),
      'napi-rs-LICENSE.txt': '2'.repeat(64),
      'fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt': '3'.repeat(64),
    };
    const packaged = {
      unpackedFiles: [
        {
          artifactPath:
            'Resources/app.asar.unpacked/node_modules/@openclaw/fs-safe-darwin-arm64/fs-safe-native.node',
          sha256: '78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0',
        },
      ],
      packages: [{ name: '@openclaw/fs-safe-darwin-arm64', version: '0.13.1' }],
      externalLegalFiles: Object.entries(legalHashes).map(([name, sha256]) => ({
        path: `licenses/${name}`,
        sha256,
      })),
    };
    expect(fsSafeMacArtifactViolations(packaged, legalHashes)).toEqual([]);
    const missingHeaderText = structuredClone(packaged);
    missingHeaderText.externalLegalFiles.pop();
    expect(fsSafeMacArtifactViolations(missingHeaderText, legalHashes)).toContain(
      'Packaged native legal supplement differs: fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt',
    );
    packaged.unpackedFiles[0]!.sha256 = '0'.repeat(64);
    packaged.packages[0]!.version = '0.13.2';
    packaged.externalLegalFiles[0]!.sha256 = '0'.repeat(64);
    expect(fsSafeMacArtifactViolations(packaged, legalHashes)).toEqual([
      'Packaged fs-safe macOS binding differs from the pinned source-scope target',
      'Packaged fs-safe macOS npm identity is missing',
      'Packaged native legal supplement differs: fs-safe-rust-ROOT-LICENSES.txt',
    ]);
  });
});
