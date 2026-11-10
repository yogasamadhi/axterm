import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditIndependentSnapshot } from './audit-independent-snapshot.mjs';

const legacyProductToken = ['elect', 'erm'].join('');
const utf16LittleEndianToken = new RegExp(
  [...legacyProductToken].map((character) => `${character}\\x00`).join(''),
  'gi',
);
const utf16BigEndianToken = new RegExp(
  [...legacyProductToken].map((character) => `\\x00${character}`).join(''),
  'gi',
);
const exceptionScopes = new Set(['content', 'path', 'all']);
const approvalDatePattern = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * @typedef {{
 *   path: string;
 *   scope: 'content' | 'path' | 'all';
 *   reason: string;
 *   approvedBy: string;
 *   approvedAt: string;
 *   approvalReference: string;
 * }} FinalPublicSnapshotException
 */

function normalizedPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function normalizedExceptionPath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) return undefined;
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (
    normalized.length === 0 ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return undefined;
  }
  return normalized;
}

function textOccurrences(content) {
  const matcher = new RegExp(legacyProductToken, 'giu');
  return [...content.matchAll(matcher)].length;
}

function byteContentOccurrences(content) {
  // Latin-1 maps each byte to one code point, so UTF-16 sequences embedded at
  // an odd byte offset in a binary resource are still visible to the scan.
  const bytes = content.toString('latin1');
  return (
    textOccurrences(bytes) +
    [...bytes.matchAll(utf16LittleEndianToken)].length +
    [...bytes.matchAll(utf16BigEndianToken)].length
  );
}

function collectFiles(root) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (stat.isFile()) files.push(path);
    }
  }

  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function exceptionValidationMessage(exception, index, root) {
  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    return `exceptions[${index}]: must be an object`;
  }
  const path = normalizedExceptionPath(exception.path);
  if (!path) return `exceptions[${index}].path: must be a snapshot-relative path`;
  if (!path.startsWith('docs/')) {
    return `exceptions[${index}].path: only documentation paths may be excepted`;
  }
  if (!existsSync(resolve(root, path))) {
    return `exceptions[${index}].path: does not exist in the candidate snapshot`;
  }
  if (!exceptionScopes.has(exception.scope)) {
    return `exceptions[${index}].scope: must be content, path or all`;
  }
  for (const field of ['reason', 'approvedBy', 'approvalReference']) {
    if (typeof exception[field] !== 'string' || exception[field].trim().length === 0) {
      return `exceptions[${index}].${field}: must be a non-empty string`;
    }
  }
  if (typeof exception.approvedAt !== 'string' || !approvalDatePattern.test(exception.approvedAt)) {
    return `exceptions[${index}].approvedAt: must use YYYY-MM-DD`;
  }
  return undefined;
}

function normalizedExceptions(exceptions, root) {
  if (!Array.isArray(exceptions)) {
    return {
      entries: [],
      violations: ['exceptions: must be an array'],
    };
  }

  const entries = [];
  const violations = [];
  const seen = new Set();
  for (const [index, exception] of exceptions.entries()) {
    const validationMessage = exceptionValidationMessage(exception, index, root);
    if (validationMessage) {
      violations.push(validationMessage);
      continue;
    }
    const path = normalizedExceptionPath(exception.path);
    const key = `${path}\0${exception.scope}`;
    if (seen.has(key)) {
      violations.push(`exceptions[${index}]: duplicate path and scope`);
      continue;
    }
    seen.add(key);
    entries.push({
      path,
      scope: exception.scope,
      reason: exception.reason.trim(),
      approvedBy: exception.approvedBy.trim(),
      approvedAt: exception.approvedAt,
      approvalReference: exception.approvalReference.trim(),
    });
  }
  return { entries, violations };
}

function appliesTo(exception, finding) {
  return (
    exception.path === finding.path &&
    (exception.scope === 'all' || exception.scope === finding.kind)
  );
}

/**
 * Audits the later, final public-source candidate after the compatibility
 * window has closed. Unlike the regular independent-snapshot audit, this
 * rejects the legacy product name in every retained file name and byte stream.
 * A narrowly recorded documentation exception is possible only for a
 * separately approved historical migration record.
 */
export function auditFinalPublicSnapshot(
  snapshotDirectory,
  /** @type {{ exceptions?: FinalPublicSnapshotException[] }} */ { exceptions = [] } = {},
) {
  const root = resolve(snapshotDirectory);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`Snapshot directory does not exist: ${root}`);
  }

  const baseAudit = auditIndependentSnapshot(root);
  const normalized = normalizedExceptions(exceptions, root);
  const findings = [];
  for (const path of collectFiles(root)) {
    const snapshotPath = normalizedPath(root, path);
    const pathOccurrences = textOccurrences(snapshotPath);
    if (pathOccurrences > 0) {
      findings.push({ path: snapshotPath, kind: 'path', occurrences: pathOccurrences });
    }
    const contentOccurrences = byteContentOccurrences(readFileSync(path));
    if (contentOccurrences > 0) {
      findings.push({ path: snapshotPath, kind: 'content', occurrences: contentOccurrences });
    }
  }

  const usedExceptions = new Set();
  const unapprovedFindings = [];
  for (const finding of findings) {
    const approval = normalized.entries.find((exception) => appliesTo(exception, finding));
    if (approval) {
      usedExceptions.add(`${approval.path}\0${approval.scope}`);
      continue;
    }
    unapprovedFindings.push(finding);
  }
  const unusedExceptions = normalized.entries
    .filter((exception) => !usedExceptions.has(`${exception.path}\0${exception.scope}`))
    .map(({ path, scope }) => ({ path, scope }));
  const violations = [
    ...baseAudit.violations.map((violation) => `snapshot hygiene: ${violation}`),
    ...normalized.violations.map((violation) => `exception record: ${violation}`),
    ...unapprovedFindings.map(
      ({ path, kind, occurrences }) =>
        `${path} (${kind}: ${occurrences} legacy-name occurrence(s))`,
    ),
    ...unusedExceptions.map(
      ({ path, scope }) => `${path} (${scope} exception did not match a legacy-name finding)`,
    ),
  ].sort();

  return {
    schemaVersion: 1,
    baseAudit,
    exceptionRecords: normalized.entries,
    invalidExceptionRecords: normalized.violations,
    legacyNameFindings: findings,
    unapprovedLegacyNameFindings: unapprovedFindings,
    unusedExceptionRecords: unusedExceptions,
    passed: violations.length === 0,
    violations,
    limitations: [
      'This is a textual and filename guard for the final public source candidate; it does not prove independent authorship, trademark clearance, source-rights review or absence of non-textual similarity.',
      'Only individually recorded documentation exceptions are mechanically permitted. The record must be reviewed by the responsible owner; this tool cannot validate the reviewer authority or conclusion.',
      'The regular snapshot check remains the migration-period hygiene gate. Run this final-public guard only after the compatibility-removal release is approved.',
    ],
  };
}

export function readFinalPublicSnapshotExceptions(exceptionPath) {
  const source = resolve(exceptionPath);
  if (!existsSync(source) || !lstatSync(source).isFile()) {
    throw new Error(`Exception record does not exist: ${source}`);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(source, 'utf8'));
  } catch {
    throw new Error(`Exception record is not valid JSON: ${source}`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Exception record must be an object: ${source}`);
  }
  if (record.schemaVersion !== 1) {
    throw new Error(`Exception record has unsupported schemaVersion: ${source}`);
  }
  if (!Array.isArray(record.exceptions)) {
    throw new Error(`Exception record must contain an exceptions array: ${source}`);
  }
  return record.exceptions;
}

function parseArguments(argumentsList) {
  const snapshotIndex = argumentsList.indexOf('--snapshot');
  const exceptionIndex = argumentsList.indexOf('--exceptions');
  const snapshotPath = snapshotIndex < 0 ? undefined : argumentsList[snapshotIndex + 1];
  const exceptionPath = exceptionIndex < 0 ? undefined : argumentsList[exceptionIndex + 1];
  const expectedLength = exceptionPath ? 4 : 2;
  if (
    !snapshotPath ||
    argumentsList.length !== expectedLength ||
    snapshotIndex !== 0 ||
    (exceptionPath && exceptionIndex !== 2)
  ) {
    return undefined;
  }
  return { snapshotPath, exceptionPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed) {
    console.error(
      'Usage: node scripts/commercialization/audit-final-public-snapshot.mjs --snapshot <path> [--exceptions <approved-record.json>]',
    );
    process.exitCode = 2;
  } else {
    try {
      const exceptions = parsed.exceptionPath
        ? readFinalPublicSnapshotExceptions(parsed.exceptionPath)
        : [];
      const report = auditFinalPublicSnapshot(parsed.snapshotPath, { exceptions });
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
  }
}
