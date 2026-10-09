import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sourceHeaderBundle,
  sourceHeaderRecordViolations,
} from '../../scripts/commercialization/ironrdp-source-headers.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const record = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.json'),
    'utf8',
  ),
);
const bundle = readFileSync(resolve('licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt'));

describe('IronRDP source-file copyright and SPDX candidates', () => {
  it('pins candidate scope without asserting actual WASM linkage', () => {
    expect(sourceHeaderRecordViolations(record, inventory, bundle)).toEqual([]);
    expect(record.sourcePackageCount).toBe(259);
    expect(record.scannedCodeFileCount).toBe(6958);
    expect(record.candidatePackageCount).toBe(51);
    expect(record.candidateFileCount).toBe(719);
    expect(record.candidateLineCount).toBe(798);
    expect(record.entries).toContainEqual(
      expect.objectContaining({
        package: 'chrono@0.4.44',
        path: 'src/format/parse.rs',
        lines: expect.arrayContaining([
          expect.objectContaining({ text: '// Portions copyright (c) 2015, John Nagle.' }),
        ]),
      }),
    );
    expect(record.limitations).toContain(
      'Candidate inclusion does not prove linkage into the published WASM or select an applicable license alternative.',
    );
  });

  it('preserves exact source lines with file hashes and rejects a mutated bundle', () => {
    expect(sourceHeaderBundle(record)).toEqual(bundle);
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(
      'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084',
    );
    const changed = Buffer.from(bundle);
    const position = changed.indexOf('John Nagle');
    expect(position).toBeGreaterThan(0);
    changed[position] = 'X'.charCodeAt(0);
    expect(sourceHeaderRecordViolations(record, inventory, changed)).toContain(
      'IronRDP source-header attribution bundle differs',
    );
  });

  it('rejects a candidate outside the pinned package graph', () => {
    const changed = structuredClone(record);
    changed.entries[0].package = 'not-in-graph@1.0.0';
    expect(sourceHeaderRecordViolations(changed, inventory, bundle)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid source-header candidate'),
        'IronRDP source-header attribution bundle differs',
      ]),
    );
  });
});
