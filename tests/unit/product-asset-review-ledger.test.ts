import { describe, expect, it } from 'vitest';
import {
  productAssetReviewLedgerFromInventory,
  productAssetReviewLedgerFromInventoryWithExisting,
  productAssetReviewLedgerViolations,
  productAssetReviewScopeSha256,
} from '../../scripts/commercialization/product-asset-review-ledger.mjs';

const inventory = {
  schemaVersion: 1,
  assets: [
    { path: 'build/icon.svg', sha256: 'a'.repeat(64) },
    { path: 'docs/logo.png', sha256: 'b'.repeat(64) },
  ],
};

function reviewedRecord() {
  return {
    status: 'reviewed',
    reviewer: 'Qualified reviewer',
    reviewedAt: '2026-09-21',
    evidence: ['internal review record'],
    conclusion: 'Scoped review completed',
  };
}

describe('product-mark asset review ledger', () => {
  it('creates a deterministic pending-only handoff for every inventory asset', () => {
    const ledger = productAssetReviewLedgerFromInventory(inventory);

    expect(ledger.sourceScopeSha256).toBe(productAssetReviewScopeSha256(inventory));
    expect(ledger.entries).toEqual([
      expect.objectContaining({
        asset: { path: 'build/icon.svg', sha256: 'a'.repeat(64) },
        publicDisposition: 'pending',
        rightsReview: expect.objectContaining({ status: 'pending' }),
        brandReview: expect.objectContaining({ status: 'pending' }),
      }),
      expect.objectContaining({
        asset: { path: 'docs/logo.png', sha256: 'b'.repeat(64) },
        publicDisposition: 'pending',
      }),
    ]);
    expect(productAssetReviewLedgerViolations(ledger, inventory)).toEqual([]);
    expect(
      productAssetReviewLedgerViolations(ledger, inventory, { requireReviewed: true }),
    ).toEqual(
      expect.arrayContaining([
        'build/icon.svg.brandReview is pending',
        'build/icon.svg.publicDisposition is pending',
        'build/icon.svg.rightsReview is pending',
      ]),
    );
  });

  it('requires a dated evidence-backed decision and preserves it only for unchanged asset bytes', () => {
    const ledger = productAssetReviewLedgerFromInventory(inventory);
    const first = ledger.entries[0]!;
    first.publicDisposition = 'retain';
    first.rightsReview = reviewedRecord();
    first.brandReview = reviewedRecord();

    expect(
      productAssetReviewLedgerViolations(ledger, inventory, { requireReviewed: true }),
    ).toEqual(
      expect.arrayContaining([
        'docs/logo.png.brandReview is pending',
        'docs/logo.png.publicDisposition is pending',
        'docs/logo.png.rightsReview is pending',
      ]),
    );

    const preserved = productAssetReviewLedgerFromInventoryWithExisting(inventory, ledger);
    expect(preserved.entries[0]?.rightsReview).toEqual(reviewedRecord());

    const changedInventory = structuredClone(inventory);
    changedInventory.assets[0]!.sha256 = 'c'.repeat(64);
    const changed = productAssetReviewLedgerFromInventoryWithExisting(changedInventory, ledger);
    expect(changed.entries[0]).toMatchObject({
      asset: { path: 'build/icon.svg', sha256: 'c'.repeat(64) },
      publicDisposition: 'pending',
      rightsReview: { status: 'pending' },
    });
  });

  it('rejects a reviewed claim without an actual reviewer, date, evidence and conclusion', () => {
    const ledger = productAssetReviewLedgerFromInventory(inventory);
    ledger.entries[0]!.rightsReview = {
      status: 'reviewed',
      reviewer: 'Reviewer',
      reviewedAt: null,
      evidence: [],
      conclusion: null,
    };

    expect(productAssetReviewLedgerViolations(ledger, inventory)).toContain(
      'build/icon.svg.rightsReview reviewed status requires reviewer, ISO date, evidence and conclusion',
    );
  });
});
