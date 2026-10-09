import { describe, expect, it } from 'vitest';
import {
  attributionReviewLedgerFromArchive,
  attributionReviewLedgerFromArchiveWithExisting,
  attributionReviewLedgerViolations,
  attributionReviewScope,
  attributionReviewScopeSha256,
} from '../../scripts/commercialization/license-attribution-review-ledger.mjs';

const archive = {
  missingCopyrightDeclarations: [
    { name: 'zeta', version: '2.0.0' },
    { name: '@scope/alpha', version: '1.0.0' },
  ],
};

describe('license-attribution review ledger', () => {
  it('creates a deterministic, pending-only review handoff from the generated archive queue', () => {
    expect(attributionReviewScope(archive)).toEqual([
      { name: '@scope/alpha', version: '1.0.0' },
      { name: 'zeta', version: '2.0.0' },
    ]);
    expect(attributionReviewScopeSha256(archive)).toMatch(/^[a-f0-9]{64}$/u);

    const ledger = attributionReviewLedgerFromArchive(archive);
    expect(ledger.entries).toEqual([
      expect.objectContaining({
        component: { name: '@scope/alpha', version: '1.0.0' },
        status: 'pending',
        reviewer: null,
        reviewedAt: null,
        evidence: [],
        conclusion: null,
      }),
      expect.objectContaining({
        component: { name: 'zeta', version: '2.0.0' },
        status: 'pending',
        reviewer: null,
        reviewedAt: null,
        evidence: [],
        conclusion: null,
      }),
    ]);
    expect(attributionReviewLedgerViolations(ledger, archive)).toEqual([]);
    expect(attributionReviewLedgerViolations(ledger, archive, { requireReviewed: true })).toEqual(
      expect.arrayContaining([
        '@scope/alpha@1.0.0: status is pending',
        'zeta@2.0.0: status is pending',
      ]),
    );
  });

  it('requires a qualified, dated evidence-backed conclusion before an entry can leave pending', () => {
    const ledger = attributionReviewLedgerFromArchive(archive);
    const alpha = ledger.entries[0];
    alpha.status = 'reviewed';
    alpha.reviewer = 'Qualified reviewer';
    alpha.reviewedAt = '2026-09-21';
    alpha.evidence = [{ reference: 'https://example.test/notice', note: 'Primary notice.' }];

    expect(attributionReviewLedgerViolations(ledger, archive)).toContain(
      '@scope/alpha@1.0.0: reviewed entries require an explicit conclusion',
    );

    alpha.conclusion = 'Copyright and notice follow-up is recorded for final qualified review.';
    expect(attributionReviewLedgerViolations(ledger, archive)).toEqual([]);

    const zeta = ledger.entries[1]!;
    Object.assign(zeta, {
      status: 'reviewed',
      reviewer: 'Qualified reviewer',
      reviewedAt: '2026-09-21',
      evidence: [{ reference: 'https://example.test/zeta-notice', note: 'Primary notice.' }],
      conclusion: 'Copyright and notice follow-up is recorded for final qualified review.',
    });
    expect(attributionReviewLedgerViolations(ledger, archive, { requireReviewed: true })).toEqual(
      [],
    );

    alpha.status = 'pending';
    expect(attributionReviewLedgerViolations(ledger, archive)).toContain(
      '@scope/alpha@1.0.0: pending entries must not claim reviewer, date, evidence or conclusion',
    );

    alpha.status = 'needs-follow-up';
    expect(attributionReviewLedgerViolations(ledger, archive, { requireReviewed: true })).toContain(
      '@scope/alpha@1.0.0: status is needs-follow-up',
    );
  });

  it('retains matching human-review records while replacing a stale generated scope', () => {
    const existing = attributionReviewLedgerFromArchive(archive);
    Object.assign(existing.entries[0], {
      status: 'needs-follow-up',
      reviewer: 'Qualified reviewer',
      reviewedAt: '2026-09-21',
      evidence: [{ reference: 'https://example.test/notice', note: 'Primary notice.' }],
      conclusion: 'Needs one more source-rights check before final release review.',
    });

    const updatedArchive = {
      missingCopyrightDeclarations: [
        { name: '@scope/alpha', version: '1.0.0' },
        { name: 'new-package', version: '3.0.0' },
      ],
    };
    const regenerated = attributionReviewLedgerFromArchiveWithExisting(updatedArchive, existing);

    expect(regenerated.entries).toEqual([
      expect.objectContaining({
        component: { name: '@scope/alpha', version: '1.0.0' },
        status: 'needs-follow-up',
        reviewer: 'Qualified reviewer',
      }),
      expect.objectContaining({
        component: { name: 'new-package', version: '3.0.0' },
        status: 'pending',
        reviewer: null,
      }),
    ]);
    expect(attributionReviewLedgerViolations(regenerated, updatedArchive)).toEqual([]);
  });
});
