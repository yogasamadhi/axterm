import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const recordPath = resolve(import.meta.dirname, '../../compliance/UPDATE_FEED_RECORD.json');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePublicUrl(value, violations) {
  if (!isNonemptyText(value)) {
    violations.push('manifestUrl must be a nonempty public HTTPS URL');
    return;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !host ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.test') ||
      host === 'example.com' ||
      host.endsWith('.example.com')
    )
      violations.push(
        'manifestUrl must be a real public HTTPS URL without credentials or fragment',
      );
  } catch {
    violations.push('manifestUrl must be a valid URL');
  }
}

function validatePublicKey(value, violations) {
  if (
    !isNonemptyText(value) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    violations.push('publicKeyBase64 must be canonical Base64-encoded Ed25519 SPKI DER');
    return;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (bytes.toString('base64') !== value || key.asymmetricKeyType !== 'ed25519')
      violations.push('publicKeyBase64 must be canonical Base64-encoded Ed25519 SPKI DER');
  } catch {
    violations.push('publicKeyBase64 must be canonical Base64-encoded Ed25519 SPKI DER');
  }
}

export function validateUpdateFeedRecord(
  record,
  { activeRequired = false, asOf = new Date() } = {},
) {
  const violations = [];
  if (!isRecord(record)) return ['Update-feed record must be a JSON object'];
  const allowedKeys = new Set([
    'schemaVersion',
    'status',
    'manifestUrl',
    'publicKeyBase64',
    'approval',
    'limitations',
  ]);
  for (const key of Object.keys(record))
    if (!allowedKeys.has(key)) violations.push(`Unexpected update-feed field: ${key}`);
  if (record.schemaVersion !== 1) violations.push('schemaVersion must be 1');
  if (!Array.isArray(record.limitations) || !record.limitations.every(isNonemptyText))
    violations.push('limitations must be an array of nonempty statements');

  if (record.status === 'pending') {
    if (activeRequired) violations.push('Public update-feed configuration is still pending');
    if (record.manifestUrl !== null || record.publicKeyBase64 !== null || record.approval !== null)
      violations.push('Pending update-feed record must not carry active feed fields');
    return violations;
  }
  if (record.status !== 'active') return [...violations, 'status must be pending or active'];

  validatePublicUrl(record.manifestUrl, violations);
  validatePublicKey(record.publicKeyBase64, violations);
  const approval = record.approval;
  if (!isRecord(approval)) {
    violations.push('Active update-feed record needs a release-owner approval');
  } else {
    if (!isNonemptyText(approval.reviewer)) violations.push('approval.reviewer is required');
    const reviewedAt = approval.reviewedAt;
    if (
      typeof reviewedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(reviewedAt) ||
      Number.isNaN(Date.parse(`${reviewedAt}T00:00:00Z`)) ||
      new Date(`${reviewedAt}T00:00:00Z`).toISOString().slice(0, 10) !== reviewedAt ||
      reviewedAt > asOf.toISOString().slice(0, 10)
    )
      violations.push('approval.reviewedAt must be a real UTC date no later than today');
    if (
      !Array.isArray(approval.evidence) ||
      !approval.evidence.length ||
      !approval.evidence.every(isNonemptyText)
    )
      violations.push('approval.evidence needs at least one nonempty reference');
    if (!isNonemptyText(approval.conclusion)) violations.push('approval.conclusion is required');
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--active-check'].includes(args[0])) {
    console.error(
      'Usage: node scripts/commercialization/update-feed-record.mjs --check|--active-check',
    );
    process.exitCode = 2;
  } else {
    let violations;
    try {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      violations = validateUpdateFeedRecord(record, {
        activeRequired: args[0] === '--active-check',
      });
    } catch (error) {
      violations = [error instanceof Error ? error.message : String(error)];
    }
    if (violations.length) {
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(
        `Update-feed record is valid in ${args[0] === '--active-check' ? 'active' : 'current'} state.`,
      );
    }
  }
}
