import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { collectSnapshotEntries } from './audit-independent-snapshot.mjs';
import { prepareIndependentSnapshot } from './prepare-independent-snapshot.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const ledgerName = 'compliance/AXTERM_SOURCE_FILE_REVIEW_LEDGER.json';
const ledgerPath = resolve(repositoryRoot, ledgerName);
const sourceDescription = 'Prepared independent source snapshot, excluding this review ledger';
const originKinds = new Set(['first-party', 'third-party', 'generated', 'historical-evidence']);
const reviewGroups = [
  {
    name: 'Asset and legal-text files',
    matches: (path) =>
      /^(apps\/desktop\/build\/|licenses\/|LICENSE$|NOTICE$|THIRD_PARTY)/u.test(path),
  },
  {
    name: 'Tests and fixtures',
    matches: (path) =>
      path.startsWith('tests/') || /(?:\/fixtures\/|\.(?:test|spec)\.[cm]?[jt]sx?$)/u.test(path),
  },
  {
    name: 'Terminal transfer and FTP implementation',
    matches: (path) =>
      /^packages\/runtime\/src\/(?:adapters\/(?:terminal-transfer\/|ftp\/|widget\/node-local-ftp-server\.ts$)|application\/terminal-transfer-)/u.test(
        path,
      ),
  },
  {
    name: 'Localization and theme implementation',
    matches: (path) =>
      /^scripts\/localization\//u.test(path) ||
      /(?:\/i18n\/|\/terminal-themes?\/|terminal-theme-presets)/u.test(path),
  },
  {
    name: 'Other product implementation',
    matches: (path) => /^(apps\/desktop\/src\/|packages\/[^/]+\/src\/)/u.test(path),
  },
  { name: 'Build and audit tooling', matches: (path) => /^(scripts\/|\.github\/)/u.test(path) },
  { name: 'Documentation and other source files', matches: () => true },
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validReviewDate(value, asOf) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && value <= asOf
  );
}

function pendingReview() {
  return {
    status: 'pending',
    originKind: null,
    source: null,
    license: null,
    rightsHolder: null,
    distribution: null,
    disposition: null,
    reviewer: null,
    reviewedAt: null,
    evidence: [],
    conclusion: null,
  };
}

export function sourceFileScope(files) {
  if (!Array.isArray(files)) throw new Error('Source-file scope must be an array');
  const scoped = files
    .filter((file) => file.path !== ledgerName)
    .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  const seen = new Set();
  for (const file of scoped) {
    if (
      !nonEmptyString(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      seen.has(file.path)
    ) {
      throw new Error(`Invalid or duplicate source-file scope entry: ${String(file.path)}`);
    }
    seen.add(file.path);
  }
  return scoped;
}

export function sourceFileScopeSha256(files) {
  const manifest = sourceFileScope(files)
    .map(({ path, bytes, sha256 }) => `${path}\0${bytes}\0${sha256}`)
    .join('\n');
  return createHash('sha256').update(manifest).digest('hex');
}

export function sourceFileReviewLedgerFromScope(files, existing) {
  const scope = sourceFileScope(files);
  const priorReviews = new Map(
    Array.isArray(existing?.entries)
      ? existing.entries
          .filter((entry) => isRecord(entry) && isRecord(entry.file))
          .map((entry) => [`${entry.file.path}\0${entry.file.sha256}`, entry.review])
      : [],
  );
  return {
    schemaVersion: 1,
    source: sourceDescription,
    sourceScopeSha256: sourceFileScopeSha256(files),
    limitations: [
      'A path and byte hash identify review scope; they do not establish authorship, license, rights or package inclusion.',
      'Git author metadata and prospective contribution rules do not grant retrospective permission for these bytes.',
      'Every changed or newly included file returns to pending; reviewed fields require attributable human evidence.',
      'This source ledger does not replace installed-binary, dependency, contributor, trademark or legal review.',
    ],
    entries: scope.map((file) => ({
      file,
      review: priorReviews.get(`${file.path}\0${file.sha256}`) ?? pendingReview(),
    })),
  };
}

function reviewViolations(path, review, requireReviewed, asOf) {
  if (!isRecord(review) || !['pending', 'reviewed'].includes(review.status)) {
    return [`${path}: review status must be pending or reviewed`];
  }
  if (review.status === 'pending') {
    const expected = pendingReview();
    if (JSON.stringify(review) !== JSON.stringify(expected)) {
      return [`${path}: pending review must not claim source, rights or approval`];
    }
    return requireReviewed ? [`${path}: source review is pending`] : [];
  }
  const invalid = [];
  if (!originKinds.has(review.originKind)) invalid.push('originKind');
  for (const field of [
    'source',
    'license',
    'rightsHolder',
    'distribution',
    'reviewer',
    'conclusion',
  ]) {
    if (!nonEmptyString(review[field])) invalid.push(field);
  }
  if (review.disposition !== 'retain') invalid.push('disposition=retain');
  if (!validReviewDate(review.reviewedAt, asOf)) invalid.push('reviewedAt');
  if (
    !Array.isArray(review.evidence) ||
    review.evidence.length === 0 ||
    !review.evidence.every(nonEmptyString)
  ) {
    invalid.push('evidence');
  }
  return invalid.length > 0 ? [`${path}: reviewed entry needs ${invalid.join(', ')}`] : [];
}

export function sourceFileReviewLedgerViolations(
  ledger,
  files,
  { requireReviewed = false, asOf = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!isRecord(ledger)) return ['Source-file review ledger is missing or invalid'];
  const violations = [];
  const scope = sourceFileScope(files);
  if (ledger.schemaVersion !== 1) violations.push('Unsupported source-file review schema');
  if (ledger.source !== sourceDescription) violations.push('Source-file review scope is invalid');
  if (ledger.sourceScopeSha256 !== sourceFileScopeSha256(files)) {
    violations.push('Source-file review scope hash is stale');
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== scope.length) {
    violations.push(`Source-file review entries must cover exactly ${scope.length} files`);
    return violations;
  }
  for (const [index, file] of scope.entries()) {
    const entry = ledger.entries[index];
    if (
      !isRecord(entry) ||
      !isRecord(entry.file) ||
      entry.file.path !== file.path ||
      entry.file.bytes !== file.bytes ||
      entry.file.sha256 !== file.sha256
    ) {
      violations.push(`${file.path}: source-file identity is stale or out of order`);
      continue;
    }
    violations.push(...reviewViolations(file.path, entry.review, requireReviewed, asOf));
  }
  return violations;
}

export function sourceFileReviewWorklist(ledger) {
  if (!isRecord(ledger) || !Array.isArray(ledger.entries)) {
    throw new Error('Source-file review ledger is missing or invalid');
  }
  /** @type {Array<{name: string, pending: Array<{path: string, bytes: number, sha256: string}>, pendingBytes: number}>} */
  const groups = reviewGroups.map(({ name }) => ({ name, pending: [], pendingBytes: 0 }));
  let reviewed = 0;
  for (const entry of ledger.entries) {
    if (!isRecord(entry) || !isRecord(entry.file) || !isRecord(entry.review)) {
      throw new Error('Source-file review worklist contains an invalid entry');
    }
    if (entry.review.status === 'reviewed') {
      reviewed += 1;
      continue;
    }
    if (entry.review.status !== 'pending') throw new Error('Unknown source-file review status');
    const index = reviewGroups.findIndex(({ matches }) => matches(entry.file.path));
    const group = groups[index];
    group.pending.push({ ...entry.file });
    group.pendingBytes += entry.file.bytes;
  }
  return {
    sourceScopeSha256: ledger.sourceScopeSha256,
    totalFiles: ledger.entries.length,
    reviewed,
    pending: ledger.entries.length - reviewed,
    groups,
  };
}

async function currentSourceScope() {
  const prepared = await prepareIndependentSnapshot(repositoryRoot);
  try {
    if (!prepared.report.passed) {
      throw new Error('Prepared source snapshot failed its hygiene audit');
    }
    return collectSnapshotEntries(prepared.snapshotDirectory).files;
  } finally {
    await rm(prepared.temporaryDirectory, { recursive: true, force: true });
  }
}

async function serializeLedger(ledger) {
  return format(JSON.stringify(ledger), { parser: 'json' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (
    !['--generate', '--check', '--reviewed-check', '--worklist'].includes(mode) ||
    process.argv.length !== 3
  ) {
    console.error(
      'Usage: node scripts/commercialization/source-file-review-ledger.mjs --generate|--check|--reviewed-check|--worklist',
    );
    process.exitCode = 2;
  } else {
    try {
      const files = await currentSourceScope();
      const existingText = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : undefined;
      const existing = existingText ? JSON.parse(existingText) : undefined;
      const ledger = sourceFileReviewLedgerFromScope(files, existing);
      const violations = sourceFileReviewLedgerViolations(ledger, files, {
        requireReviewed: mode === '--reviewed-check',
      });
      const expectedText = await serializeLedger(ledger);
      if (mode === '--generate') {
        if (violations.length > 0) throw new Error(violations.join('\n'));
        writeFileSync(ledgerPath, expectedText);
        console.log(`Updated ${ledgerName}: ${ledger.entries.length} source files`);
      } else {
        if (existingText !== expectedText) violations.push('Source-file review ledger is stale');
        if (violations.length > 0) {
          for (const violation of violations) console.error(violation);
          process.exitCode = 1;
        } else if (mode === '--worklist') {
          const worklist = sourceFileReviewWorklist(ledger);
          console.log(
            `Source review worklist: ${worklist.pending} pending, ${worklist.reviewed} reviewed, ${worklist.totalFiles} total; scope ${worklist.sourceScopeSha256}`,
          );
          console.log(
            'Routing groups only; no source, rights, license or distribution approval is inferred.',
          );
          for (const group of worklist.groups) {
            console.log(
              `\n${group.name}: ${group.pending.length} pending, ${group.pendingBytes} bytes`,
            );
            for (const file of group.pending) {
              console.log(`${file.path}\t${file.bytes}\t${file.sha256}`);
            }
          }
        } else {
          console.log(`Source-file review ledger matches ${ledger.entries.length} files`);
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
