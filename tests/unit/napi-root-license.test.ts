import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  napiCrateSources,
  napiRootLicenseViolations,
} from '../../scripts/commercialization/verify-napi-rs-root-license.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const license = readFileSync(resolve('licenses/napi-rs-LICENSE.txt'));

describe('napi-rs missing-root Cargo license supplement', () => {
  it('pins the exact four missing-root published crates and upstream MIT text', () => {
    expect(napiCrateSources.map(({ name, version }) => `${name}@${version}`)).toEqual([
      'napi@3.12.2',
      'napi-derive@3.6.3',
      'napi-derive-backend@6.1.2',
      'napi-sys@3.3.0',
    ]);
    expect(napiRootLicenseViolations(inventory, license)).toEqual([]);
    expect(license.toString('utf8')).toContain('Copyright (c) 2020-present LongYinan');
    expect(license.toString('utf8')).toContain('Copyright (c) 2018 GitHub');
  });

  it('rejects license-byte or missing-root scope drift', () => {
    const alteredLicense = Buffer.from(license);
    alteredLicense.writeUInt8(alteredLicense.readUInt8(0) ^ 1, 0);
    expect(napiRootLicenseViolations(inventory, alteredLicense)).toContain(
      'napi-rs upstream root LICENSE bytes differ',
    );
    const changedInventory = structuredClone(inventory);
    changedInventory.packages.find(
      (entry: { name: string }) => entry.name === 'napi',
    )!.rootLicenseFiles = [{ name: 'LICENSE', sha256: '0'.repeat(64) }];
    expect(napiRootLicenseViolations(changedInventory, license)).toContainEqual(
      expect.stringContaining('Registry packages without root legal files differ'),
    );
  });

  it('keeps the upstream-root supplement discoverable in source, package and Legal/About', () => {
    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    const builder = readFileSync(resolve('apps/desktop/electron-builder.yml'), 'utf8');
    const panel = readFileSync(
      resolve('apps/desktop/src/renderer/src/app/legal-notices-panel.tsx'),
      'utf8',
    );
    expect(notices).toContain('licenses/napi-rs-LICENSE.txt');
    expect(builder).toContain('from: ../../licenses');
    expect(panel).toContain('licenses/*.txt');
  });
});
