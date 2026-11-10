import { describe, expect, it } from 'vitest';
import {
  sourceFileReviewLedgerFromScope,
  sourceFileReviewLedgerViolations,
  sourceFileReviewWorklist,
  sourceFileScopeSha256,
} from '../../scripts/commercialization/source-file-review-ledger.mjs';

const files = [
  { path: 'packages/runtime/src/a.ts', bytes: 3, sha256: 'a'.repeat(64) },
  { path: 'apps/desktop/src/b.ts', bytes: 4, sha256: 'b'.repeat(64) },
  { path: 'compliance/AXTERM_SOURCE_FILE_REVIEW_LEDGER.json', bytes: 1, sha256: 'c'.repeat(64) },
];

function approvedReview() {
  return {
    status: 'reviewed',
    originKind: 'first-party',
    source: 'maintainer-authored implementation at reviewed commit',
    license: 'Apache-2.0',
    rightsHolder: 'Reviewed rightsholder',
    distribution: 'Source and macOS package',
    disposition: 'retain',
    reviewer: 'Qualified reviewer',
    reviewedAt: '2026-09-24',
    evidence: ['Controlled approval receipt #123'],
    conclusion: 'Retain under the approved grant',
  };
}

describe('per-file source-rights review handoff', () => {
  it('lists every prepared source byte except its own self-referential ledger', () => {
    const ledger = sourceFileReviewLedgerFromScope(files);
    expect(ledger.entries.map(({ file }: { file: { path: string } }) => file.path)).toEqual([
      'apps/desktop/src/b.ts',
      'packages/runtime/src/a.ts',
    ]);
    expect(
      ledger.entries.every(
        ({ review }: { review: { status: string } }) => review.status === 'pending',
      ),
    ).toBe(true);
    expect(sourceFileReviewLedgerViolations(ledger, files)).toEqual([]);
    expect(sourceFileReviewLedgerViolations(ledger, files, { requireReviewed: true })).toEqual([
      'apps/desktop/src/b.ts: source review is pending',
      'packages/runtime/src/a.ts: source review is pending',
    ]);
    expect(sourceFileScopeSha256(files)).toBe(sourceFileScopeSha256(files.slice(0, 2)));
  });

  it('preserves a reviewed entry only when its exact file hash is unchanged', () => {
    const existing = sourceFileReviewLedgerFromScope(files);
    const first = existing.entries[0];
    if (!first) throw new Error('Expected the first source-file review entry');
    first.review = approvedReview();
    const unchanged = sourceFileReviewLedgerFromScope(files, existing);
    expect(unchanged.entries[0]?.review).toEqual(approvedReview());
    expect(sourceFileReviewLedgerViolations(unchanged, files)).toEqual([]);

    const changed = files.map((file) =>
      file.path === 'apps/desktop/src/b.ts' ? { ...file, sha256: 'd'.repeat(64) } : file,
    );
    const regenerated = sourceFileReviewLedgerFromScope(changed, existing);
    expect(regenerated.entries[0]?.review.status).toBe('pending');
    expect(sourceFileReviewLedgerViolations(existing, changed)).toContain(
      'Source-file review scope hash is stale',
    );
  });

  it('rejects unsupported source claims and accepts only attributable retained reviews', () => {
    const ledger = sourceFileReviewLedgerFromScope(files);
    const [first, second] = ledger.entries;
    if (!first || !second) throw new Error('Expected two source-file review entries');
    first.review = { ...approvedReview(), source: '' };
    expect(sourceFileReviewLedgerViolations(ledger, files, { requireReviewed: true })).toContain(
      'apps/desktop/src/b.ts: reviewed entry needs source',
    );
    first.review = approvedReview();
    second.review = approvedReview();
    expect(sourceFileReviewLedgerViolations(ledger, files, { requireReviewed: true })).toEqual([]);
  });

  it('rejects invalid and future review dates without changing pending review semantics', () => {
    const ledger = sourceFileReviewLedgerFromScope(files);
    const first = ledger.entries[0];
    if (!first) throw new Error('Expected a source-file review entry');
    for (const reviewedAt of ['2026-02-30', '2026-09-25', '2026-9-24']) {
      first.review = { ...approvedReview(), reviewedAt };
      expect(sourceFileReviewLedgerViolations(ledger, files, { asOf: '2026-09-24' })).toContain(
        'apps/desktop/src/b.ts: reviewed entry needs reviewedAt',
      );
    }
    first.review = approvedReview();
    expect(sourceFileReviewLedgerViolations(ledger, files, { asOf: '2026-09-24' })).toEqual([]);
  });

  it('routes every pending file exactly once without treating a group as approval', () => {
    const routedFiles = [
      ...files,
      { path: 'apps/desktop/build/icon.svg', bytes: 5, sha256: 'd'.repeat(64) },
      { path: 'tests/unit/example.test.ts', bytes: 6, sha256: 'e'.repeat(64) },
      { path: 'scripts/check.mjs', bytes: 7, sha256: 'f'.repeat(64) },
      { path: 'docs/README.md', bytes: 8, sha256: '0'.repeat(64) },
      { path: 'packages/runtime/src/example.test.ts', bytes: 9, sha256: '1'.repeat(64) },
      { path: 'packages/client/src/api-client.ts', bytes: 10, sha256: '2'.repeat(64) },
      {
        path: 'packages/runtime/src/adapters/terminal-transfer/xmodem.ts',
        bytes: 11,
        sha256: '3'.repeat(64),
      },
      {
        path: 'apps/desktop/src/renderer/src/i18n/provider.tsx',
        bytes: 12,
        sha256: '4'.repeat(64),
      },
    ];
    const ledger = sourceFileReviewLedgerFromScope(routedFiles);
    const reviewed = ledger.entries.find(
      (entry) => entry.file.path === 'packages/runtime/src/a.ts',
    );
    if (!reviewed) throw new Error('Expected the runtime source-file review entry');
    reviewed.review = approvedReview();

    expect(sourceFileReviewLedgerViolations(ledger, routedFiles, { asOf: '2026-09-24' })).toEqual(
      [],
    );
    const worklist = sourceFileReviewWorklist(ledger);
    expect(worklist).toMatchObject({ totalFiles: 10, reviewed: 1, pending: 9 });
    expect(worklist.groups.map(({ name, pending }) => [name, pending.length])).toEqual([
      ['Asset and legal-text files', 1],
      ['Tests and fixtures', 2],
      ['Terminal transfer and FTP implementation', 1],
      ['Localization and theme implementation', 1],
      ['Other product implementation', 2],
      ['Build and audit tooling', 1],
      ['Documentation and other source files', 1],
    ]);
    expect(worklist.groups.flatMap(({ pending }) => pending.map(({ path }) => path))).toEqual([
      'apps/desktop/build/icon.svg',
      'packages/runtime/src/example.test.ts',
      'tests/unit/example.test.ts',
      'packages/runtime/src/adapters/terminal-transfer/xmodem.ts',
      'apps/desktop/src/renderer/src/i18n/provider.tsx',
      'apps/desktop/src/b.ts',
      'packages/client/src/api-client.ts',
      'scripts/check.mjs',
      'docs/README.md',
    ]);
    expect(
      worklist.groups.flatMap(({ pending }) => pending).every(({ sha256 }) => sha256.length === 64),
    ).toBe(true);
    expect(ledger.entries.filter(({ review }) => review.status === 'pending')).toHaveLength(9);
  });
});
