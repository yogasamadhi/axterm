import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const archivePath = resolve(repositoryRoot, 'compliance/THIRD_PARTY_LICENSE_TEXTS.json');
const outputPath = resolve(repositoryRoot, 'compliance/LICENSE_ATTRIBUTION_REVIEW_LEDGER.json');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function componentIdentity({ name, version }) {
  return `${name}@${version}`;
}

export function attributionReviewScope(archive) {
  if (!Array.isArray(archive.missingCopyrightDeclarations))
    throw new Error('License archive has no missingCopyrightDeclarations array');
  const entries = archive.missingCopyrightDeclarations.map(({ name, version }) => {
    if (typeof name !== 'string' || !name || typeof version !== 'string' || !version)
      throw new Error('License archive has an invalid missingCopyrightDeclarations entry');
    return { name, version };
  });
  const identities = new Set(entries.map(componentIdentity));
  if (identities.size !== entries.length)
    throw new Error('License archive has duplicate missingCopyrightDeclarations entries');
  return entries.sort((left, right) =>
    compareText(componentIdentity(left), componentIdentity(right)),
  );
}

export function attributionReviewScopeSha256(archive) {
  return createHash('sha256')
    .update(JSON.stringify(attributionReviewScope(archive)))
    .digest('hex');
}

export function attributionReviewLedgerFromArchive(archive) {
  return attributionReviewLedgerFromArchiveWithExisting(archive);
}

function requiredReview() {
  return 'Record qualified reviewer, date, primary source/notice references and an explicit conclusion before changing this status.';
}

function pendingEntry(component) {
  return {
    component,
    status: 'pending',
    reviewer: null,
    reviewedAt: null,
    evidence: [],
    conclusion: null,
    requiredReview: requiredReview(),
  };
}

function retainedEntry(component, existingEntry) {
  if (!existingEntry || typeof existingEntry !== 'object') return pendingEntry(component);
  return {
    component,
    status: existingEntry.status ?? 'pending',
    reviewer: existingEntry.reviewer ?? null,
    reviewedAt: existingEntry.reviewedAt ?? null,
    evidence: existingEntry.evidence ?? [],
    conclusion: existingEntry.conclusion ?? null,
    requiredReview: requiredReview(),
  };
}

export function attributionReviewLedgerFromArchiveWithExisting(archive, existingLedger) {
  const existingEntries = new Map(
    Array.isArray(existingLedger?.entries)
      ? existingLedger.entries
          .filter((entry) => entry?.component)
          .map((entry) => [componentIdentity(entry.component), entry])
      : [],
  );
  return {
    schemaVersion: 1,
    source: 'THIRD_PARTY_LICENSE_TEXTS.json missingCopyrightDeclarations',
    sourceScopeSha256: attributionReviewScopeSha256(archive),
    scope:
      'Production packages with neither a manifest copyright field nor a copyright line in a root LICENSE/COPYING/NOTICE file.',
    limitations: [
      'This ledger is a human-review handoff, not a copyright, license, source-rights or distribution conclusion.',
      'Publisher author/contributor metadata is preserved in THIRD_PARTY_LICENSE_TEXTS.json but does not satisfy this review.',
      'A reviewed entry cannot by itself accept IR-02 or IR-11; final review also covers generated, inlined, native, WASM, Electron/Chromium and platform artifacts.',
    ],
    entries: attributionReviewScope(archive).map((component) =>
      retainedEntry(component, existingEntries.get(componentIdentity(component))),
    ),
  };
}

function validEvidence(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.reference === 'string' &&
        entry.reference.trim() &&
        typeof entry.note === 'string' &&
        entry.note.trim(),
    )
  );
}

function validIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

export function attributionReviewLedgerViolations(
  ledger,
  archive,
  { requireReviewed = false } = {},
) {
  const violations = [];
  if (!ledger || typeof ledger !== 'object') return ['Ledger is not an object'];
  if (ledger.schemaVersion !== 1) violations.push('Ledger schemaVersion must be 1');
  if (ledger.source !== 'THIRD_PARTY_LICENSE_TEXTS.json missingCopyrightDeclarations')
    violations.push('Ledger source is not the generated license archive queue');
  if (ledger.sourceScopeSha256 !== attributionReviewScopeSha256(archive))
    violations.push(
      'Ledger sourceScopeSha256 is stale; regenerate then preserve any reviewed evidence',
    );
  if (!Array.isArray(ledger.entries)) {
    violations.push('Ledger entries must be an array');
    return violations;
  }

  const expected = attributionReviewScope(archive);
  const actual = ledger.entries.map(({ component }) => component).filter(Boolean);
  const expectedIdentities = expected.map(componentIdentity);
  const actualIdentities = actual.map(componentIdentity);
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities))
    violations.push('Ledger entries do not exactly match the generated missing-copyright queue');

  for (const entry of ledger.entries) {
    const identity = componentIdentity(entry.component ?? {});
    if (!['pending', 'reviewed', 'needs-follow-up'].includes(entry.status)) {
      violations.push(`${identity}: status must be pending, reviewed or needs-follow-up`);
      continue;
    }
    if (!validEvidence(entry.evidence)) {
      violations.push(`${identity}: evidence must contain non-empty reference and note fields`);
      continue;
    }
    if (entry.status === 'pending') {
      if (
        entry.reviewer !== null ||
        entry.reviewedAt !== null ||
        entry.evidence.length !== 0 ||
        entry.conclusion !== null
      )
        violations.push(
          `${identity}: pending entries must not claim reviewer, date, evidence or conclusion`,
        );
      if (requireReviewed) violations.push(`${identity}: status is pending`);
      continue;
    }
    if (typeof entry.reviewer !== 'string' || !entry.reviewer.trim())
      violations.push(`${identity}: reviewed entries require a named reviewer`);
    if (!validIsoDate(entry.reviewedAt))
      violations.push(`${identity}: reviewed entries require an ISO reviewedAt date`);
    if (entry.evidence.length === 0)
      violations.push(`${identity}: reviewed entries require primary evidence`);
    if (typeof entry.conclusion !== 'string' || !entry.conclusion.trim())
      violations.push(`${identity}: reviewed entries require an explicit conclusion`);
    if (requireReviewed && entry.status !== 'reviewed')
      violations.push(`${identity}: status is ${entry.status}`);
  }
  return violations;
}

export async function serializeAttributionReviewLedger(ledger) {
  return format(JSON.stringify(ledger), { parser: 'json', printWidth: 100 });
}

function readArchive() {
  return JSON.parse(readFileSync(archivePath, 'utf8'));
}

async function generatedLedger() {
  const existingLedger =
    process.argv[2] === '--generate' &&
    (() => {
      try {
        return JSON.parse(readFileSync(outputPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    })();
  return serializeAttributionReviewLedger(
    attributionReviewLedgerFromArchiveWithExisting(readArchive(), existingLedger),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(outputPath, await generatedLedger());
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check' || mode === '--reviewed-check') {
    const archive = readArchive();
    const ledger = JSON.parse(readFileSync(outputPath, 'utf8'));
    const requireReviewed = mode === '--reviewed-check';
    const violations = attributionReviewLedgerViolations(ledger, archive, { requireReviewed });
    if (violations.length) {
      console.error('License-attribution review ledger is invalid:');
      for (const violation of violations) console.error(`- ${violation}`);
      process.exitCode = 1;
    } else {
      console.log(
        requireReviewed
          ? `Reviewed license-attribution ledger is ready for the scoped promotion gate (${ledger.entries.length} packages).`
          : `License-attribution review ledger matches ${ledger.entries.length} pending/reviewed package entries.`,
      );
    }
  } else {
    console.error(
      'Usage: node scripts/commercialization/license-attribution-review-ledger.mjs --generate|--check|--reviewed-check',
    );
    process.exitCode = 2;
  }
}
