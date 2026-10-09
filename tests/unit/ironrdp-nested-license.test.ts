import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ironRdpNestedLicenseViolations,
  nestedLegalPathsFromArchiveListing,
  tracingCoreSpinLicense,
} from '../../scripts/commercialization/ironrdp-nested-license.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const original = readFileSync(resolve(tracingCoreSpinLicense.packagedPath));

describe('IronRDP tracing-core nested legal text', () => {
  it('pins the exact MIT notice and locked crate identity', () => {
    expect(ironRdpNestedLicenseViolations(inventory, original)).toEqual([]);
    expect(original.toString('utf8')).toContain('Copyright (c) 2014 Mathijs van de Nes');
    const changed = Buffer.from(original);
    changed[changed.indexOf('Mathijs')] = 'X'.charCodeAt(0);
    expect(ironRdpNestedLicenseViolations(inventory, changed)).toContain(
      'tracing-core nested spin license bytes differ',
    );
  });

  it('detects archive-internal legal names but not similarly named Rust source', () => {
    const listing = [
      'tracing-core-0.1.36/LICENSE',
      'tracing-core-0.1.36/src/spin/LICENSE',
      'tracing-core-0.1.36/src/license_exchange.rs',
      'tracing-core-0.1.36/src/spin/mutex.rs',
    ].join('\n');
    expect(
      nestedLegalPathsFromArchiveListing(listing, {
        name: 'tracing-core',
        version: '0.1.36',
      }),
    ).toEqual(['src/spin/LICENSE']);
  });

  it('invalidates the supplement when the locked crate checksum changes', () => {
    const changed = structuredClone(inventory);
    const crate = changed.packages.find(
      ({ name }: { name: string }) => name === tracingCoreSpinLicense.name,
    );
    crate.checksum = '0'.repeat(64);
    expect(ironRdpNestedLicenseViolations(changed, original)).toContain(
      'Pinned tracing-core crate identity or declaration differs',
    );
  });
});
