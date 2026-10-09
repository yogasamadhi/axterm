import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inventoryViolations,
  ironRdpArtifactViolations,
  ironRdpRootLicenseBundleViolations,
  ironRdpSourceSpdx,
  parseIronRdpCargoLock,
  parseIronRdpCargoTree,
} from '../../scripts/commercialization/ironrdp-wasm-source-scope.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const legalBundle = readFileSync(resolve('licenses/IronRDP-RUST-ROOT-LICENSES.txt'));

describe('IronRDP wasm-target source and legal-text scope', () => {
  it('pins only the ironrdp-web target-specific normal/build graph', () => {
    expect(inventoryViolations(inventory)).toEqual([]);
    expect(inventory.packages).toHaveLength(259);
    expect(inventory.registryPackageCount).toBe(236);
    expect(inventory.workspacePackageCount).toBe(23);
    expect(inventory.packageRootLegalFileCount).toBe(468);
    expect(
      inventory.packages.filter(
        ({ rootLegalFiles }: { rootLegalFiles: unknown[] }) => rootLegalFiles.length === 0,
      ),
    ).toHaveLength(11);
    expect(inventory.packages).toContainEqual(
      expect.objectContaining({
        name: 'ironrdp-web',
        source: 'workspace',
        path: 'crates/ironrdp-web',
      }),
    );
    expect(inventory.limitations).toContain(
      'The npm attestation connects the tarball to this source commit, but a byte-for-byte WASM rebuild has not been achieved.',
    );
  });

  it('rejects ambiguous or changed Cargo input rather than broadening silently', () => {
    expect(
      parseIronRdpCargoTree('ironrdp-web v0.0.0 (/source)\nanyhow v1.0.102\nanyhow v1.0.102 (*)'),
    ).toEqual(['anyhow@1.0.102', 'ironrdp-web@0.0.0']);
    expect(() => parseIronRdpCargoTree('anyhow v1.0.102')).toThrow('lacks ironrdp-web');
    expect(() =>
      parseIronRdpCargoLock(
        '[[package]]\nname = "a"\nversion = "1"\n[[package]]\nname = "a"\nversion = "1"',
      ),
    ).toThrow('Ambiguous Cargo.lock identity');
    const changed = structuredClone(inventory);
    changed.packages[0].checksum = '0'.repeat(63);
    expect(inventoryViolations(changed)).toContainEqual(
      expect.stringContaining('locked crate checksum'),
    );
  });

  it('verifies every preserved legal-file byte and rejects a mutated text', () => {
    expect(ironRdpRootLicenseBundleViolations(inventory, legalBundle)).toEqual([]);
    const changed = Buffer.from(legalBundle);
    const textStart = changed.indexOf('Apache License');
    expect(textStart).toBeGreaterThan(0);
    changed[textStart] = 'X'.charCodeAt(0);
    expect(ironRdpRootLicenseBundleViolations(inventory, changed)).toContainEqual(
      expect.stringContaining('Changed original bytes'),
    );
  });

  it('keeps Cargo source SPDX separate from the packaged binary and license conclusions', () => {
    const spdx = ironRdpSourceSpdx(inventory, { name: 'axterm', version: '0.10.0' });
    expect(spdx.packages).toHaveLength(259);
    expect(spdx.documentDescribes).toHaveLength(259);
    expect(
      spdx.packages.every(
        ({
          licenseConcluded,
          primaryPackagePurpose,
        }: {
          licenseConcluded: string;
          primaryPackagePurpose: string;
        }) => licenseConcluded === 'NOASSERTION' && primaryPackagePurpose === 'SOURCE',
      ),
    ).toBe(true);
    expect(spdx.comment).toContain('not a source-to-WASM build proof');
    expect(
      JSON.parse(
        readFileSync(resolve('compliance/AXTERM_IRONRDP_WASM_CARGO_SOURCE.spdx.json'), 'utf8'),
      ),
    ).toEqual(spdx);
  });

  it('rejects an artifact without the expected npm identity, legal bytes or unique Renderer bundle', () => {
    const packaged = {
      packages: [{ name: '@devolutions/iron-remote-desktop-rdp', version: '0.7.0' }],
      externalLegalFiles: [
        {
          path: 'licenses/IronRDP-RUST-ROOT-LICENSES.txt',
          sha256: '4f90cf224ed4e9b0a4e9f6fb2428c98eeccc2f2ab17c063d0543aba266337a96',
        },
        {
          path: 'licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt',
          sha256: '7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0',
        },
        {
          path: 'licenses/tracing-core-spin-LICENSE.txt',
          sha256: '58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79',
        },
        {
          path: 'licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt',
          sha256: 'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084',
        },
        {
          path: 'licenses/IronRDP-LICENSE-APACHE.txt',
          sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
        },
      ],
      rendererAssetFiles: [
        { path: '/out/renderer/assets/iron-remote-desktop-rdp-abc.js', sha256: '1'.repeat(64) },
      ],
    };
    expect(ironRdpArtifactViolations(packaged)).toEqual([]);
    packaged.externalLegalFiles[1]!.sha256 = '0'.repeat(64);
    expect(ironRdpArtifactViolations(packaged)).toEqual([
      'Packaged IronRDP missing-crate publisher root texts differ',
    ]);
    packaged.externalLegalFiles[1]!.sha256 =
      '7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0';
    packaged.externalLegalFiles[2]!.sha256 = '0'.repeat(64);
    expect(ironRdpArtifactViolations(packaged)).toEqual([
      'Packaged tracing-core nested spin license differs',
    ]);
    packaged.externalLegalFiles[2]!.sha256 =
      '58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79';
    packaged.packages[0]!.version = '0.7.1';
    packaged.externalLegalFiles[0]!.sha256 = '0'.repeat(64);
    packaged.rendererAssetFiles.push({ ...packaged.rendererAssetFiles[0]! });
    expect(ironRdpArtifactViolations(packaged)).toEqual([
      'Packaged IronRDP npm identity is missing',
      'Packaged IronRDP Rust root legal texts differ',
      'Expected one packaged IronRDP Renderer bundle',
    ]);
  });
});
