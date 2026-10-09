import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLegacyUiKeys } from './audit-legacy-ui-keys.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = resolve(repositoryRoot, 'scripts/localization/axterm-navigation-source.json');
const reviewLedgerPath = resolve(
  repositoryRoot,
  'scripts/localization/axterm-navigation-review-ledger.json',
);
const outputPath = resolve(
  repositoryRoot,
  'apps/desktop/src/renderer/src/i18n/axterm-navigation.generated.json',
);

export const supportedLocales = [
  { id: 'en', name: 'English', flag: '🇺🇸', match: 'en' },
  { id: 'ja', name: '日本語', flag: '🇯🇵', match: 'ja' },
  { id: 'zh-CN', name: '简体中文', flag: '🇨🇳', match: 'zh-CN' },
  { id: 'zh-TW', name: '繁體中文', flag: '🇹🇼', match: 'zh-TW' },
];

function placeholders(message) {
  return [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map((match) => match[1]).sort();
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function keySha256(requiredKeys) {
  return createHash('sha256')
    .update([...requiredKeys].sort().join('\n'))
    .digest('hex');
}

function validateReviewStep(locale, name, step) {
  if (!isRecord(step) || !['pending', 'reviewed'].includes(step.status)) {
    throw new Error(`${locale}.${name} must have a pending or reviewed status`);
  }
  if (step.status === 'pending') {
    if (step.reviewer !== null || step.reviewedAt !== null)
      throw new Error(`${locale}.${name} pending review must not name a reviewer or date`);
    return false;
  }
  if (!nonEmptyString(step.reviewer) || !isoDate(step.reviewedAt)) {
    throw new Error(`${locale}.${name} reviewed status requires reviewer and review date`);
  }
  return true;
}

/**
 * Validates the evidence record that separates an AI-assisted translation
 * draft from an independently reviewed publication claim.
 */
export function validateNavigationReviewLedger(ledger, requiredKeys) {
  if (!isRecord(ledger) || ledger.schemaVersion !== 1 || ledger.catalog !== 'navigation') {
    throw new Error('Unsupported Axterm navigation review-ledger schema');
  }
  if (
    !isRecord(ledger.scope) ||
    ledger.scope.keyCount !== requiredKeys.length ||
    ledger.scope.keySha256 !== keySha256(requiredKeys)
  ) {
    throw new Error('Navigation review ledger does not match the current Renderer key scope');
  }
  if (!isRecord(ledger.locales)) throw new Error('Navigation review ledger has no locales');

  const expectedLocaleIds = supportedLocales.map(({ id }) => id).sort();
  const actualLocaleIds = Object.keys(ledger.locales).sort();
  if (JSON.stringify(actualLocaleIds) !== JSON.stringify(expectedLocaleIds)) {
    throw new Error('Navigation review ledger locale set does not match supported locales');
  }

  const pendingReviewLocaleIds = [];
  for (const locale of expectedLocaleIds) {
    const entry = ledger.locales[locale];
    if (!isRecord(entry) || !isRecord(entry.draft)) {
      throw new Error(`${locale} review ledger has no draft record`);
    }
    const draft = entry.draft;
    if (
      !nonEmptyString(draft.sourceLanguage) ||
      !nonEmptyString(draft.method) ||
      !isoDate(draft.preparedAt)
    ) {
      throw new Error(
        `${locale} draft record is missing source language, method, or preparation date`,
      );
    }
    if (!['recorded', 'unrecorded'].includes(draft.attributionStatus)) {
      throw new Error(`${locale} draft record has invalid attribution status`);
    }
    if (
      (draft.attributionStatus === 'recorded' && !nonEmptyString(draft.author)) ||
      (draft.attributionStatus === 'unrecorded' && draft.author !== null)
    ) {
      throw new Error(`${locale} draft attribution does not match its attribution status`);
    }
    const languageReviewed = validateReviewStep(locale, 'languageReview', entry.languageReview);
    const rightsReviewed = validateReviewStep(locale, 'rightsReview', entry.rightsReview);
    if (languageReviewed && rightsReviewed && draft.attributionStatus !== 'recorded') {
      throw new Error(`${locale} cannot be reviewed until the draft author is recorded`);
    }
    if (!languageReviewed || !rightsReviewed) pendingReviewLocaleIds.push(locale);
  }
  return {
    keyCount: requiredKeys.length,
    pendingReviewLocaleIds,
    reviewedLocaleIds: expectedLocaleIds.filter((id) => !pendingReviewLocaleIds.includes(id)),
  };
}

export function validateNavigationSource(source, requiredKeys) {
  if (source.schemaVersion !== 1 || source.baseLanguage !== 'en') {
    throw new Error('Unsupported Axterm navigation source schema');
  }
  if (!source.draftOrigin || !source.draftOrigin.includes('review pending')) {
    throw new Error('Translation draft provenance/review status is missing');
  }
  const supportedIds = supportedLocales.map(({ id }) => id);
  const entries = Object.entries(source.messages ?? {});
  if (!entries.some(([id]) => id === 'en')) throw new Error('English source copy is required');
  const unexpectedLocales = entries.map(([id]) => id).filter((id) => !supportedIds.includes(id));
  if (unexpectedLocales.length) throw new Error(`Unknown locale: ${unexpectedLocales.join(', ')}`);
  const keys = [...requiredKeys].sort();
  for (const [id, messages] of entries) {
    const actualKeys = Object.keys(messages).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(keys)) {
      throw new Error(`${id} keys differ from the ${keys.length}-key Renderer usage scope`);
    }
    for (const key of keys) {
      const message = messages[key];
      if (
        typeof message !== 'string' ||
        !message.trim() ||
        message !== message.trim() ||
        [...message].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint < 32 || codePoint === 127;
        })
      ) {
        throw new Error(`${id}.${key} is empty or contains unsafe whitespace/control text`);
      }
      if (
        id !== 'en' &&
        JSON.stringify(placeholders(message)) !==
          JSON.stringify(placeholders(source.messages.en[key]))
      ) {
        throw new Error(`${id}.${key} has different interpolation variables from English`);
      }
    }
  }
  return {
    keyCount: keys.length,
    draftedLocaleIds: entries.map(([id]) => id).sort(),
    pendingLocaleIds: supportedIds.filter((id) => !source.messages[id]),
  };
}

export function generateNavigationCatalog(source, reviewLedger) {
  const usage = auditLegacyUiKeys({ catalogFile: null });
  if (usage.unrecognizedDynamicCalls.length) {
    throw new Error('Review new dynamic navigation keys before generating the catalog');
  }
  const result = validateNavigationSource(source, usage.usedKeys);
  const review = validateNavigationReviewLedger(reviewLedger, usage.usedKeys);
  if (result.pendingLocaleIds.length) {
    throw new Error(`Translation drafts are missing: ${result.pendingLocaleIds.join(', ')}`);
  }
  const orderedKeys = [...usage.usedKeys].sort();
  return {
    schemaVersion: 1,
    source: {
      project: 'Axterm',
      catalog: 'navigation',
      reviewStatus: review.pendingReviewLocaleIds.length === 0 ? 'reviewed' : 'draft',
    },
    keyCount: orderedKeys.length,
    locales: supportedLocales.map((definition) => ({
      ...definition,
      messages: Object.fromEntries(
        orderedKeys.map((key) => [key, source.messages[definition.id][key]]),
      ),
    })),
  };
}

/**
 * Verifies the narrower promotion gate for the generated navigation catalog.
 * It deliberately does not imply that all broader `x()` product copy has been
 * translated or reviewed; that remains an IR-05 release-evidence requirement.
 */
export function verifyReviewedNavigationCatalog(source, reviewLedger, generatedCatalog) {
  const expected = generateNavigationCatalog(source, reviewLedger);
  if (expected.source.reviewStatus !== 'reviewed') {
    const usage = auditLegacyUiKeys({ catalogFile: null });
    const review = validateNavigationReviewLedger(reviewLedger, usage.usedKeys);
    throw new Error(
      `Navigation catalog is not ready for reviewed promotion; pending locales: ${review.pendingReviewLocaleIds.join(', ')}`,
    );
  }
  if (JSON.stringify(generatedCatalog) !== JSON.stringify(expected)) {
    throw new Error('Generated reviewed navigation catalog is stale');
  }
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const reviewLedger = JSON.parse(readFileSync(reviewLedgerPath, 'utf8'));
  const usage = auditLegacyUiKeys({ catalogFile: null });
  const draft = validateNavigationSource(source, usage.usedKeys);
  const review = validateNavigationReviewLedger(reviewLedger, usage.usedKeys);
  if (process.argv.includes('--generate')) {
    const output = generateNavigationCatalog(source, reviewLedger);
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`Generated ${output.locales.length} Axterm navigation catalogs at ${outputPath}`);
  } else if (process.argv.includes('--reviewed-navigation-check')) {
    const output = JSON.parse(readFileSync(outputPath, 'utf8'));
    verifyReviewedNavigationCatalog(source, reviewLedger, output);
    console.log(`Verified reviewed Axterm navigation catalog for ${output.locales.length} locales`);
  } else if (process.argv.includes('--check')) {
    const output = generateNavigationCatalog(source, reviewLedger);
    if (readFileSync(outputPath, 'utf8') !== `${JSON.stringify(output, null, 2)}\n`) {
      throw new Error('Generated Axterm navigation catalog is stale');
    }
    console.log(`Verified ${output.locales.length} Axterm navigation catalogs`);
  } else {
    console.log(
      `Axterm navigation draft: ${draft.draftedLocaleIds.length}/${supportedLocales.length} ` +
        `locales, ${draft.keyCount} keys; translation drafts missing: ` +
        `${draft.pendingLocaleIds.join(', ') || 'none'}; human review pending: ` +
        `${review.pendingReviewLocaleIds.join(', ') || 'none'}`,
    );
  }
}
