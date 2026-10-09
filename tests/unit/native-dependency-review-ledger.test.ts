import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  nativeReviewLedgerFromInventory,
  nativeReviewLedgerViolations,
  nativeReviewScope,
  installedMacArm64NativeBinaryViolations,
} from '../../scripts/commercialization/native-dependency-review-ledger.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const ledger = JSON.parse(
  readFileSync(resolve('compliance/NATIVE_DEPENDENCY_REVIEW_LEDGER.json'), 'utf8'),
);

describe('macOS native dependency review ledger', () => {
  it('tracks every exact source package and the published binary without inventing approval', () => {
    expect(nativeReviewScope(inventory)).toHaveLength(61);
    expect(nativeReviewLedgerViolations(ledger, inventory)).toEqual([]);
    expect(nativeReviewLedgerViolations(ledger, inventory, { requireReviewed: true })).toHaveLength(
      62,
    );
    const changedHeader = structuredClone(ledger);
    const candidateEntry = changedHeader.entries.find(
      ({ package: component }: { package: { name: string } }) =>
        component.name === 'futures-channel',
    );
    candidateEntry.package.sourceHeaderCandidates.sha256 = '0'.repeat(64);
    expect(nativeReviewLedgerViolations(changedHeader, inventory)).toContain(
      'futures-channel@0.3.34: source package scope differs',
    );
    expect(
      ledger.entries.every(
        ({ review }: { review: { status: string } }) => review.status === 'pending',
      ),
    ).toBe(true);
    expect(ledger.nativeBinary.review.status).toBe('pending');
    expect(
      ledger.entries.find(
        ({ package: component }: { package: { name: string } }) =>
          component.name === 'futures-channel',
      )?.package.sourceHeaderCandidates,
    ).toMatchObject({ fileCount: 1, lineCount: 1 });
  });

  it('rejects scope drift and resets review when a source legal file changes', () => {
    const changed = structuredClone(inventory);
    changed.packages[0].rootLicenseFiles[0].sha256 = '0'.repeat(64);
    expect(nativeReviewLedgerViolations(ledger, changed)).toContain(
      'Native review ledger source scope has drifted',
    );

    const existing = structuredClone(ledger);
    existing.entries[0].review = {
      status: 'reviewed',
      reviewer: 'Qualified reviewer',
      reviewedAt: '2026-09-24',
      evidence: [{ reference: 'review-record', note: 'Checked exact source and notice' }],
      conclusion: 'Permission and attribution documented',
      noticeDisposition: 'packaged',
    };
    expect(nativeReviewLedgerViolations(existing, inventory)).toEqual([]);
    const regenerated = nativeReviewLedgerFromInventory(changed, existing);
    expect(regenerated.entries[0].review.status).toBe('pending');
    expect(regenerated.entries[1].review.status).toBe('pending');
  });

  it('does not accept a reviewed label without reviewer, evidence and notice disposition', () => {
    const fake = structuredClone(ledger);
    fake.entries[0].review.status = 'reviewed';
    expect(nativeReviewLedgerViolations(fake, inventory)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('named reviewer is required'),
        expect.stringContaining('primary evidence references and notes are required'),
        expect.stringContaining('notice disposition must be packaged or not-applicable'),
      ]),
    );
  });

  it('pins the actual installed macOS arm64 native binding, not only its manifest', () => {
    expect(installedMacArm64NativeBinaryViolations(Buffer.from('wrong binary'))).toContain(
      'Installed macOS arm64 native binding differs from the reviewed binary scope',
    );
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    const desktopRequire = createRequire(resolve('apps/desktop/package.json'));
    const parentManifest = desktopRequire.resolve('@openclaw/fs-safe/package.json');
    const nativePath = createRequire(parentManifest).resolve('@openclaw/fs-safe-darwin-arm64');
    expect(installedMacArm64NativeBinaryViolations(readFileSync(nativePath))).toEqual([]);
  });
});
