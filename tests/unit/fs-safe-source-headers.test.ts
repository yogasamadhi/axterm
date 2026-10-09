import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fsSafeSourceHeaderBundle,
  fsSafeSourceHeaderRecordViolations,
} from '../../scripts/commercialization/fs-safe-source-headers.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const record = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.json'),
    'utf8',
  ),
);
const bundle = readFileSync(resolve('licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt'));

describe('fs-safe macOS source-file copyright and SPDX candidates', () => {
  it('pins candidate scope without asserting native-binary linkage', () => {
    expect(fsSafeSourceHeaderRecordViolations(record, inventory, bundle)).toEqual([]);
    expect(record.sourcePackageCount).toBe(61);
    expect(record.scannedCodeFileCount).toBe(2157);
    expect(record.candidatePackageCount).toBe(9);
    expect(record.candidateFileCount).toBe(156);
    expect(record.candidateLineCount).toBe(156);
    expect(record.entries).toContainEqual(
      expect.objectContaining({
        package: 'futures-channel@0.3.34',
        path: 'src/mpsc/queue.rs',
        lines: expect.arrayContaining([
          expect.objectContaining({
            text: '/* Copyright (c) 2010-2011 Dmitry Vyukov. All rights reserved.',
          }),
        ]),
      }),
    );
    expect(record.limitations).toContain(
      'Candidate inclusion does not prove linkage into the published native binary or select an applicable license alternative.',
    );
    expect(readFileSync(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain(
      'licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt',
    );
  });

  it('preserves exact lines with file hashes and rejects a changed bundle', () => {
    expect(fsSafeSourceHeaderBundle(record)).toEqual(bundle);
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(
      '52186f73b215d7863766c152499f6bb2caea70187f8e6fe7165a4f6c65a95a8a',
    );
    const changed = Buffer.from(bundle);
    const position = changed.indexOf('Dmitry Vyukov');
    expect(position).toBeGreaterThan(0);
    changed[position] = 'X'.charCodeAt(0);
    expect(fsSafeSourceHeaderRecordViolations(record, inventory, changed)).toContain(
      'fs-safe source-header attribution bundle differs',
    );
  });

  it('rejects a candidate outside the pinned package graph', () => {
    const changed = structuredClone(record);
    changed.entries[0].package = 'not-in-graph@1.0.0';
    expect(fsSafeSourceHeaderRecordViolations(changed, inventory, bundle)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Invalid fs-safe source-header candidate'),
        'fs-safe source-header attribution bundle differs',
      ]),
    );
  });
});
