import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { supportedLocales } from './generate-axterm-navigation.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const coreCatalogPath = resolve(repositoryRoot, 'apps/desktop/src/renderer/src/i18n/core.ts');
const reviewLedgerPath = resolve(
  repositoryRoot,
  'scripts/localization/axterm-core-review-ledger.json',
);
const coreCatalogRelativePath = 'apps/desktop/src/renderer/src/i18n/core.ts';
const preparedAt = '2026-09-21';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nameOf(property) {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  throw new Error('Axterm core catalog must use literal locale and message keys');
}

function stringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  throw new Error('Axterm core catalog must use literal message strings');
}

function findAxtermMessages(source) {
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'axtermMessages',
    );
  if (!declaration?.initializer || !ts.isAsExpression(declaration.initializer))
    throw new Error('Axterm core message catalog not found');
  if (!ts.isObjectLiteralExpression(declaration.initializer.expression))
    throw new Error('Axterm core message catalog must be a literal object');
  return declaration.initializer.expression;
}

/**
 * Extracts only literal catalog data; it never imports the Renderer or accepts
 * generated/runtime values as translation evidence.
 */
export function extractCoreCatalog(sourceText, sourcePath = coreCatalogPath) {
  const source = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const catalog = findAxtermMessages(source);
  const messagesByLocale = {};
  for (const locale of catalog.properties) {
    if (!ts.isPropertyAssignment(locale) || !ts.isObjectLiteralExpression(locale.initializer))
      throw new Error('Axterm core locale must be a literal message object');
    const localeId = nameOf(locale.name);
    if (messagesByLocale[localeId]) throw new Error(`Duplicate Axterm core locale: ${localeId}`);
    const messages = {};
    for (const entry of locale.initializer.properties) {
      if (!ts.isPropertyAssignment(entry))
        throw new Error(`Axterm core locale ${localeId} must use literal message entries`);
      const key = nameOf(entry.name);
      if (Object.hasOwn(messages, key))
        throw new Error(`Duplicate Axterm core message key: ${localeId}.${key}`);
      messages[key] = stringValue(entry.initializer);
    }
    messagesByLocale[localeId] = messages;
  }

  const english = messagesByLocale.en;
  const simplifiedChinese = messagesByLocale['zh-CN'];
  if (!english || !simplifiedChinese)
    throw new Error(
      'Axterm core catalog must retain literal English and Simplified Chinese entries',
    );
  const keys = Object.keys(english).sort();
  if (!keys.length) throw new Error('Axterm core catalog has no English message keys');
  if (JSON.stringify(Object.keys(simplifiedChinese).sort()) !== JSON.stringify(keys))
    throw new Error('Simplified Chinese Axterm core keys do not match English');

  const supportedLocaleIds = new Set(supportedLocales.map(({ id }) => id));
  for (const [localeId, messages] of Object.entries(messagesByLocale)) {
    if (!supportedLocaleIds.has(localeId))
      throw new Error(`Axterm core catalog contains an unsupported locale: ${localeId}`);
    for (const key of Object.keys(messages)) {
      if (!Object.hasOwn(english, key))
        throw new Error(`Axterm core locale ${localeId} contains an unknown message key: ${key}`);
    }
  }

  return {
    keyCount: keys.length,
    keySha256: sha256(keys.join('\n')),
    messageSha256ByLocale: Object.fromEntries(
      supportedLocales.map(({ id: localeId }) => {
        const messages = messagesByLocale[localeId];
        return [
          localeId,
          messages
            ? sha256(
                JSON.stringify(
                  Object.entries(messages).sort(([left], [right]) => left.localeCompare(right)),
                ),
              )
            : null,
        ];
      }),
    ),
    messagesByLocale,
  };
}

function expectedCoverage(catalog, localeId) {
  const translatedKeyCount = Object.keys(catalog.messagesByLocale[localeId] ?? {}).length;
  return {
    status:
      translatedKeyCount === catalog.keyCount
        ? 'complete'
        : translatedKeyCount > 0
          ? 'partial'
          : 'english-fallback',
    translatedKeyCount,
  };
}

function sourceMethod(localeId, coverage, keyCount) {
  if (localeId === 'ja' || localeId === 'zh-TW') {
    const coverageLabel = coverage.status === 'complete' ? 'complete' : 'partial';
    return `AI-assisted ${coverageLabel} Axterm core draft (${coverage.translatedKeyCount}/${keyCount} keys); provenance review pending`;
  }
  if (coverage.status === 'complete')
    return 'Existing Axterm core catalog; provenance review pending';
  return 'English fallback only; no target-language core draft exists';
}

function validateReviewStep(localeId, name, step) {
  if (!isRecord(step) || !['pending', 'reviewed'].includes(step.status))
    throw new Error(`${localeId}.${name} must have a pending or reviewed status`);
  if (step.status === 'pending') {
    if (step.reviewer !== null || step.reviewedAt !== null)
      throw new Error(`${localeId}.${name} pending review must not name a reviewer or date`);
    return false;
  }
  if (!nonEmptyString(step.reviewer) || !isoDate(step.reviewedAt))
    throw new Error(`${localeId}.${name} reviewed status requires reviewer and review date`);
  return true;
}

function validateDraft(localeId, draft) {
  if (!isRecord(draft) || !nonEmptyString(draft.sourceLanguage) || !nonEmptyString(draft.method))
    throw new Error(`${localeId} core review ledger has no valid source record`);
  if (!isoDate(draft.preparedAt))
    throw new Error(`${localeId} core source record has no preparation date`);
  if (!['recorded', 'unrecorded'].includes(draft.attributionStatus))
    throw new Error(`${localeId} core source record has an invalid attribution status`);
  if (
    (draft.attributionStatus === 'recorded' && !nonEmptyString(draft.author)) ||
    (draft.attributionStatus === 'unrecorded' && draft.author !== null)
  ) {
    throw new Error(`${localeId} core source attribution does not match its status`);
  }
}

/**
 * The ledger describes actual current runtime coverage. It cannot label an
 * English fallback as translated merely because a reviewer field was filled.
 */
export function validateCoreReviewLedger(ledger, catalog) {
  if (!isRecord(ledger) || ledger.schemaVersion !== 1 || ledger.catalog !== 'core')
    throw new Error('Unsupported Axterm core review-ledger schema');
  if (
    !isRecord(ledger.scope) ||
    ledger.scope.sourceFile !== coreCatalogRelativePath ||
    ledger.scope.keyCount !== catalog.keyCount ||
    ledger.scope.keySha256 !== catalog.keySha256 ||
    ledger.scope.englishMessageSha256 !== catalog.messageSha256ByLocale.en ||
    ledger.scope.simplifiedChineseMessageSha256 !== catalog.messageSha256ByLocale['zh-CN'] ||
    JSON.stringify(ledger.scope.messageSha256ByLocale) !==
      JSON.stringify(catalog.messageSha256ByLocale)
  ) {
    throw new Error('Core review ledger does not match the current Axterm message catalog');
  }
  if (!isRecord(ledger.locales)) throw new Error('Core review ledger has no locale records');

  const expectedLocaleIds = supportedLocales.map(({ id }) => id).sort();
  const actualLocaleIds = Object.keys(ledger.locales).sort();
  if (JSON.stringify(actualLocaleIds) !== JSON.stringify(expectedLocaleIds))
    throw new Error('Core review ledger locale set does not match supported locales');

  const fallbackLocaleIds = [];
  const partialLocaleIds = [];
  const pendingReviewLocaleIds = [];
  for (const localeId of expectedLocaleIds) {
    const entry = ledger.locales[localeId];
    if (!isRecord(entry)) throw new Error(`${localeId} core review record is invalid`);
    validateDraft(localeId, entry.source);
    if (!isRecord(entry.coverage)) throw new Error(`${localeId} core coverage record is invalid`);
    const expected = expectedCoverage(catalog, localeId);
    if (
      entry.coverage.status !== expected.status ||
      entry.coverage.translatedKeyCount !== expected.translatedKeyCount
    ) {
      throw new Error(
        `${localeId} core coverage must reflect the actual ${expected.status} runtime catalog`,
      );
    }
    const languageReviewed = validateReviewStep(localeId, 'languageReview', entry.languageReview);
    const rightsReviewed = validateReviewStep(localeId, 'rightsReview', entry.rightsReview);
    if (languageReviewed && rightsReviewed && entry.source.attributionStatus !== 'recorded')
      throw new Error(
        `${localeId} core copy cannot be reviewed until its source author is recorded`,
      );
    if (expected.status === 'english-fallback') fallbackLocaleIds.push(localeId);
    if (expected.status === 'partial') partialLocaleIds.push(localeId);
    if (!languageReviewed || !rightsReviewed) pendingReviewLocaleIds.push(localeId);
  }
  return {
    keyCount: catalog.keyCount,
    fallbackLocaleIds,
    partialLocaleIds,
    incompleteLocaleIds: [...partialLocaleIds, ...fallbackLocaleIds],
    pendingReviewLocaleIds,
  };
}

export function createCoreReviewLedger(catalog) {
  const locales = {};
  for (const { id } of supportedLocales) {
    const coverage = expectedCoverage(catalog, id);
    locales[id] = {
      source: {
        sourceLanguage: 'en',
        method: sourceMethod(id, coverage, catalog.keyCount),
        preparedAt,
        attributionStatus: 'unrecorded',
        author: null,
      },
      coverage,
      languageReview: { status: 'pending', reviewer: null, reviewedAt: null },
      rightsReview: { status: 'pending', reviewer: null, reviewedAt: null },
    };
  }
  return {
    schemaVersion: 1,
    catalog: 'core',
    scope: {
      sourceFile: coreCatalogRelativePath,
      keyCount: catalog.keyCount,
      keySha256: catalog.keySha256,
      englishMessageSha256: catalog.messageSha256ByLocale.en,
      simplifiedChineseMessageSha256: catalog.messageSha256ByLocale['zh-CN'],
      messageSha256ByLocale: catalog.messageSha256ByLocale,
    },
    locales,
  };
}

/**
 * This is deliberately a narrow content-review precondition. It cannot prove
 * supported-platform E2E, product/brand approval, or IR-05 acceptance.
 */
export function verifyReviewedCoreCoverage(ledger, catalog) {
  const review = validateCoreReviewLedger(ledger, catalog);
  if (review.incompleteLocaleIds.length || review.pendingReviewLocaleIds.length) {
    throw new Error(
      `Core catalog is not ready for reviewed promotion; incomplete core locales: ` +
        `${review.incompleteLocaleIds.join(', ') || 'none'}; pending reviews: ` +
        `${review.pendingReviewLocaleIds.join(', ') || 'none'}`,
    );
  }
  return review;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = extractCoreCatalog(readFileSync(coreCatalogPath, 'utf8'));
  if (process.argv.includes('--generate')) {
    const ledger = createCoreReviewLedger(catalog);
    writeFileSync(reviewLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`Generated Axterm core review ledger for ${catalog.keyCount} keys`);
  } else {
    const ledger = JSON.parse(readFileSync(reviewLedgerPath, 'utf8'));
    if (process.argv.includes('--reviewed-core-check')) {
      verifyReviewedCoreCoverage(ledger, catalog);
      console.log(`Verified reviewed Axterm core coverage for ${catalog.keyCount} keys`);
    } else if (process.argv.includes('--check')) {
      const review = validateCoreReviewLedger(ledger, catalog);
      console.log(
        `Verified Axterm core review ledger: ${catalog.keyCount} keys; partial core locales: ` +
          `${review.partialLocaleIds.join(', ') || 'none'}; English fallback locales: ` +
          `${review.fallbackLocaleIds.join(', ') || 'none'}; pending reviews: ` +
          `${review.pendingReviewLocaleIds.join(', ') || 'none'}`,
      );
    } else {
      throw new Error('Use --generate, --check, or --reviewed-core-check');
    }
  }
}
