import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type NativeSourcePackage = {
  name: string;
  version: string;
  license: string;
  source: 'registry' | 'tag-source';
  rootLicenseFiles: Array<{ name: string; sha256: string }>;
};

const evidence = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
) as {
  schemaVersion: number;
  source: { tag: string; commit: string; cargoLockSha256: string };
  target: string;
  packageCount: number;
  packages: NativeSourcePackage[];
};

describe('fs-safe macOS native source handoff', () => {
  it('pins the exact source and over-inclusive Cargo graph used for the macOS rebuild', () => {
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.source).toMatchObject({
      tag: 'v0.13.1',
      commit: '7022a0a10c53e36f34a467df68ed5614a1db1741',
      cargoLockSha256: 'd169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd',
    });
    expect(evidence.target).toBe('aarch64-apple-darwin');
    expect(evidence.packageCount).toBe(61);
    expect(evidence.packages).toHaveLength(evidence.packageCount);
    const identities = evidence.packages.map(({ name, version }) => `${name}@${version}`);
    expect(identities).toEqual([...new Set(identities)].sort((a, b) => a.localeCompare(b)));
    expect(identities).toContain('fs-safe-native@0.13.1');
    expect(identities).toContain('rustix@1.1.4');
    expect(identities).toContain('unicode-normalization@0.1.25');
    expect(identities).toContain('zstd@0.14.0');
    expect(evidence.packages.every(({ license }) => !!license)).toBe(true);
    for (const entry of evidence.packages) {
      expect(['registry', 'tag-source']).toContain(entry.source);
      for (const file of entry.rootLicenseFiles) {
        expect(file.name).toMatch(/^(?:LICEN[CS]E|COPYING|NOTICE)/iu);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
    expect(evidence.packages.flatMap(({ rootLicenseFiles }) => rootLicenseFiles)).toHaveLength(110);
  });

  it('keeps missing root legal texts visible rather than treating MIT manifest labels as clearance', () => {
    expect(
      evidence.packages
        .filter(({ rootLicenseFiles }) => rootLicenseFiles.length === 0)
        .map(({ name, version }) => `${name}@${version}`),
    ).toEqual([
      'fs-safe-archive-core@0.1.0',
      'fs-safe-native@0.13.1',
      'napi-derive-backend@6.1.2',
      'napi-derive@3.6.3',
      'napi-sys@3.3.0',
      'napi@3.12.2',
    ]);
    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notices).toContain('@openclaw/fs-safe 0.13.1');
    expect(notices).toContain('native package declares MIT but does not contain its own root');
  });
});
