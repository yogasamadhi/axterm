import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  missingRootBundleViolations,
  missingRootCandidates,
  missingRootRecordViolations,
} from '../../scripts/commercialization/ironrdp-missing-root-licenses.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const record = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.json'),
    'utf8',
  ),
);
const bundle = readFileSync(resolve('licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt'));

describe('IronRDP missing published-crate root legal-text supplement', () => {
  it('maps exactly six missing-root registry crates to immutable publisher commits', () => {
    expect(missingRootCandidates(inventory)).toHaveLength(6);
    expect(missingRootRecordViolations(record, inventory)).toEqual([]);
    expect(record.publisherRootLegalFileCount).toBe(12);
    expect(
      record.packages.every(
        ({ rootLegalFiles }: { rootLegalFiles: unknown[] }) => rootLegalFiles.length === 2,
      ),
    ).toBe(true);
    expect(record.packages).toContainEqual(
      expect.objectContaining({
        name: 'winscard',
        commit: 'fee71292aa03c569caeb44ec2782f3b5598f20c8',
        pathInVcs: 'crates/winscard',
        matchedLibSha256: '0c7307595b9de62490ac39ea0daa78eef2eddb498e192a44812a9cf31ec3ff18',
      }),
    );
  });

  it('pins each original legal-file byte, not merely its name', () => {
    expect(missingRootBundleViolations(record, bundle)).toEqual([]);
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(
      '7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0',
    );
    const changed = Buffer.from(bundle);
    const textStart = changed.indexOf('Apache License');
    expect(textStart).toBeGreaterThan(0);
    changed[textStart] = 'X'.charCodeAt(0);
    expect(missingRootBundleViolations(record, changed)).toContainEqual(
      expect.stringContaining('Changed original bytes'),
    );
  });

  it('requires a fresh audit if the target graph or publisher commit changes', () => {
    const changed = structuredClone(inventory);
    changed.packages.push({
      name: 'new-missing-root-crate',
      version: '1.0.0',
      source: 'registry',
      checksum: '0'.repeat(64),
      license: 'MIT',
      rootLegalFiles: [],
    });
    expect(() => missingRootCandidates(changed)).toThrow('missing-root registry scope has changed');
    const changedRecord = structuredClone(record);
    changedRecord.packages[0].commit = '0'.repeat(40);
    expect(missingRootRecordViolations(changedRecord, inventory)).toContainEqual(
      expect.stringContaining('crate/source identity differs'),
    );
  });
});
