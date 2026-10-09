import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditLegacyUiKeys } from '../../scripts/localization/audit-legacy-ui-keys.mjs';
import {
  generateNavigationCatalog,
  validateNavigationReviewLedger,
  validateNavigationSource,
  verifyReviewedNavigationCatalog,
} from '../../scripts/localization/generate-axterm-navigation.mjs';

const source = JSON.parse(
  readFileSync(resolve('scripts/localization/axterm-navigation-source.json'), 'utf8'),
);
const requiredKeys = auditLegacyUiKeys().usedKeys;
const reviewLedger = JSON.parse(
  readFileSync(resolve('scripts/localization/axterm-navigation-review-ledger.json'), 'utf8'),
);

describe('Axterm-authored navigation catalog draft', () => {
  it('has four complete drafts without claiming finished review', () => {
    const report = validateNavigationSource(source, requiredKeys);
    expect(report.keyCount).toBe(42);
    expect(report.draftedLocaleIds).toHaveLength(4);
    expect(report.pendingLocaleIds).toEqual([]);
    expect(
      validateNavigationReviewLedger(reviewLedger, requiredKeys).pendingReviewLocaleIds,
    ).toHaveLength(4);
    expect(generateNavigationCatalog(source, reviewLedger).locales).toHaveLength(4);
  });

  it('rejects a reviewed claim without a reviewer, date, author, and matching key scope', () => {
    const incompleteReview = structuredClone(reviewLedger);
    incompleteReview.locales.ja.languageReview.status = 'reviewed';
    expect(() => validateNavigationReviewLedger(incompleteReview, requiredKeys)).toThrow(
      'ja.languageReview reviewed status requires reviewer and review date',
    );

    const missingAttribution = structuredClone(reviewLedger);
    missingAttribution.locales.ja.languageReview = {
      status: 'reviewed',
      reviewer: 'Japanese reviewer',
      reviewedAt: '2026-09-21',
    };
    missingAttribution.locales.ja.rightsReview = {
      status: 'reviewed',
      reviewer: 'Rights reviewer',
      reviewedAt: '2026-09-21',
    };
    expect(() => validateNavigationReviewLedger(missingAttribution, requiredKeys)).toThrow(
      'ja cannot be reviewed until the draft author is recorded',
    );

    const staleScope = structuredClone(reviewLedger);
    staleScope.scope.keySha256 = '0'.repeat(64);
    expect(() => validateNavigationReviewLedger(staleScope, requiredKeys)).toThrow(
      'Navigation review ledger does not match the current Renderer key scope',
    );
  });

  it('requires all language and rights sign-offs before navigation can be promoted as reviewed', () => {
    const generatedDraft = generateNavigationCatalog(source, reviewLedger);
    expect(() => verifyReviewedNavigationCatalog(source, reviewLedger, generatedDraft)).toThrow(
      'Navigation catalog is not ready for reviewed promotion; pending locales:',
    );

    const reviewedLedger = structuredClone(reviewLedger);
    for (const entry of Object.values(reviewedLedger.locales) as Array<{
      draft: { attributionStatus: string; author: string | null };
      languageReview: { status: string; reviewer: string | null; reviewedAt: string | null };
      rightsReview: { status: string; reviewer: string | null; reviewedAt: string | null };
    }>) {
      entry.draft.attributionStatus = 'recorded';
      entry.draft.author = 'Recorded draft author';
      entry.languageReview = {
        status: 'reviewed',
        reviewer: 'Qualified language reviewer',
        reviewedAt: '2026-09-21',
      };
      entry.rightsReview = {
        status: 'reviewed',
        reviewer: 'Qualified rights reviewer',
        reviewedAt: '2026-09-21',
      };
    }
    const reviewedCatalog = generateNavigationCatalog(source, reviewedLedger);
    expect(reviewedCatalog.source.reviewStatus).toBe('reviewed');
    expect(verifyReviewedNavigationCatalog(source, reviewedLedger, reviewedCatalog)).toEqual(
      reviewedCatalog,
    );

    const staleCatalog = structuredClone(reviewedCatalog);
    staleCatalog.source.reviewStatus = 'draft';
    expect(() => verifyReviewedNavigationCatalog(source, reviewedLedger, staleCatalog)).toThrow(
      'Generated reviewed navigation catalog is stale',
    );
  });

  it('rejects missing labels and changed interpolation variables', () => {
    const missing = structuredClone(source);
    delete missing.messages['zh-CN'].settingSync;
    expect(() => validateNavigationSource(missing, requiredKeys)).toThrow(
      'zh-CN keys differ from the 42-key Renderer usage scope',
    );

    const variable = structuredClone(source);
    variable.messages.en.setting = 'Settings for {account}';
    expect(() => validateNavigationSource(variable, requiredKeys)).toThrow(
      'ja.setting has different interpolation variables from English',
    );
  });
});
