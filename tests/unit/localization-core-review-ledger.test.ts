import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractCoreCatalog,
  validateCoreReviewLedger,
  verifyReviewedCoreCoverage,
} from '../../scripts/localization/generate-axterm-core-review-ledger.mjs';

function currentCatalog() {
  return extractCoreCatalog(
    readFileSync(resolve('apps/desktop/src/renderer/src/i18n/core.ts'), 'utf8'),
  );
}

function currentLedger() {
  return JSON.parse(
    readFileSync(resolve('scripts/localization/axterm-core-review-ledger.json'), 'utf8'),
  ) as unknown;
}

describe('Axterm core-copy review ledger', () => {
  it('binds all four locales to the exact core catalog without mistaking draft coverage for review', () => {
    const catalog = currentCatalog();
    const review = validateCoreReviewLedger(currentLedger(), catalog);

    expect(catalog.keyCount).toBe(2_615);
    const messages = catalog.messagesByLocale as Record<string, Record<string, string>>;
    for (const locale of ['en', 'ja', 'zh-CN', 'zh-TW']) {
      for (const key of [
        'app.transferActionFailed',
        'app.transferReselect',
        'app.transferReconnectRequired',
        'app.transferReselectRequired',
        'app.transferAtomicUnavailable',
        'ai.chatTask',
        'ai.workspace',
        'ai.executionLocal',
        'ai.executionSsh',
        'ai.workspaceUnavailable',
        'ai.reviewingCommand',
        'ai.automaticallyApproved',
        'ai.commandReview',
      ]) {
        expect(messages[locale]?.[key]).toBeTruthy();
      }
    }
    expect(review.fallbackLocaleIds).toEqual([]);
    expect(review.partialLocaleIds).toEqual([]);
    expect(review.incompleteLocaleIds).toEqual([]);
    expect(review.pendingReviewLocaleIds).toHaveLength(4);
    const current = currentLedger() as {
      locales: Record<string, { source: { method: string } }>;
    };
    expect(current.locales.ja!.source.method).toContain('AI-assisted complete Axterm core draft');
    expect(current.locales['zh-TW']!.source.method).toContain(
      'AI-assisted complete Axterm core draft',
    );
    const falselyDemoted = structuredClone(currentLedger()) as {
      locales: Record<string, { coverage: { status: string; translatedKeyCount: number } }>;
    };
    falselyDemoted.locales.ja!.coverage = {
      status: 'partial',
      translatedKeyCount: catalog.keyCount - 1,
    };
    expect(() => validateCoreReviewLedger(falselyDemoted, catalog)).toThrow(
      /actual complete runtime catalog/u,
    );
    expect(() => verifyReviewedCoreCoverage(currentLedger(), catalog)).toThrow(/pending reviews/u);
  });
});
