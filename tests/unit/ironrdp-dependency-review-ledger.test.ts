import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ironRdpReviewLedgerFromInventory,
  ironRdpReviewLedgerViolations,
  ironRdpReviewScope,
} from '../../scripts/commercialization/ironrdp-dependency-review-ledger.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const ledger = JSON.parse(
  readFileSync(resolve('compliance/IRONRDP_DEPENDENCY_REVIEW_LEDGER.json'), 'utf8'),
);

describe('IronRDP Rust source and published-WASM human review gate', () => {
  it('covers all 259 exact candidate packages and the published WASM without inventing approval', () => {
    expect(ironRdpReviewScope(inventory)).toHaveLength(259);
    expect(
      ironRdpReviewScope(inventory).filter(
        ({ publisherRootLegalFiles }: { publisherRootLegalFiles?: unknown[] }) =>
          publisherRootLegalFiles?.length === 2,
      ),
    ).toHaveLength(6);
    expect(
      ironRdpReviewScope(inventory).filter(
        ({ nestedLegalFiles }: { nestedLegalFiles?: unknown[] }) => nestedLegalFiles?.length === 1,
      ),
    ).toHaveLength(1);
    expect(
      ironRdpReviewScope(inventory).filter(
        ({ sourceHeaderCandidates }: { sourceHeaderCandidates?: { fileCount: number } }) =>
          (sourceHeaderCandidates?.fileCount ?? 0) > 0,
      ),
    ).toHaveLength(51);
    expect(ironRdpReviewLedgerViolations(ledger, inventory)).toEqual([]);
    expect(
      ironRdpReviewLedgerViolations(ledger, inventory, { requireReviewed: true }),
    ).toHaveLength(260);
    expect(
      ledger.entries.every(
        ({ review }: { review: { status: string } }) => review.status === 'pending',
      ),
    ).toBe(true);
    expect(ledger.publishedWasm.review.status).toBe('pending');
  });

  it('rejects a forged reviewed label without a reviewer, evidence and notice decision', () => {
    const changed = structuredClone(ledger);
    changed.entries[0].review.status = 'reviewed';
    expect(ironRdpReviewLedgerViolations(changed, inventory)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('named reviewer is required'),
        expect.stringContaining('primary evidence references and notes are required'),
        expect.stringContaining('notice disposition is required'),
      ]),
    );
  });

  it('invalidates a prior approval if package legal bytes or the published WASM target change', () => {
    const approved = structuredClone(ledger);
    approved.entries[0].review = {
      status: 'reviewed',
      reviewer: 'Qualified reviewer',
      reviewedAt: '2026-09-24',
      evidence: [{ reference: 'primary-review-record', note: 'Checked exact source and notice' }],
      conclusion: 'Permission and notice disposition documented',
      noticeDisposition: 'packaged',
    };
    expect(ironRdpReviewLedgerViolations(approved, inventory)).toEqual([]);

    const changed = structuredClone(inventory);
    changed.packages[0].rootLegalFiles[0].sha256 = '0'.repeat(64);
    expect(ironRdpReviewLedgerViolations(ledger, changed)).toContain(
      'IronRDP review ledger source scope has drifted',
    );
    const regenerated = ironRdpReviewLedgerFromInventory(changed, approved);
    expect(regenerated.entries[0].review.status).toBe('pending');
    const priorBinary = structuredClone(approved);
    priorBinary.publishedWasm.review = approved.entries[0].review;
    priorBinary.publishedWasm.embeddedWasmSha256 = '0'.repeat(64);
    expect(
      ironRdpReviewLedgerFromInventory(inventory, priorBinary).publishedWasm.review.status,
    ).toBe('pending');
  });
});
