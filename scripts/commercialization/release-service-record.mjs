import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const recordPath = resolve(repositoryRoot, 'compliance/RELEASE_SERVICE_RECORD.json');

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function publicHttpsUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const hasSensitiveQuery = [...url.searchParams.keys()].some((key) =>
      /(?:token|secret|password|credential|signature|api[-_]?key|auth)/iu.test(key),
    );
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      host !== '' &&
      host !== 'localhost' &&
      host !== '::1' &&
      !host.startsWith('127.') &&
      !host.endsWith('.local') &&
      !host.endsWith('.example') &&
      !host.endsWith('.test') &&
      !host.endsWith('.invalid') &&
      !host.includes('example.') &&
      !hasSensitiveQuery
    );
  } catch {
    return false;
  }
}

function publicReportChannel(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') {
      return (
        /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/u.test(url.pathname) &&
        !url.pathname.toLowerCase().includes('example')
      );
    }
    return publicHttpsUrl(value);
  } catch {
    return false;
  }
}

function nonEmptyReferences(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function publicChannels(value, validator) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(validator) &&
    new Set(value).size === value.length
  );
}

function approvalViolations(name, value, asOf) {
  if (!isRecord(value)) return [`${name} must be an object`];
  const violations = [];
  if (!nonEmptyString(value.approvedBy)) violations.push(`${name}.approvedBy is required`);
  if (!validIsoDate(value.approvedAt)) {
    violations.push(`${name}.approvedAt must be an ISO date`);
  } else if (value.approvedAt > asOf) {
    violations.push(`${name}.approvedAt cannot be after the current UTC date`);
  }
  if (!nonEmptyReferences(value.evidence)) violations.push(`${name}.evidence is required`);
  return violations;
}

function privacyViolations(value, asOf) {
  const name = 'privacyAndDataHandling';
  const violations = approvalViolations(name, value, asOf);
  if (!isRecord(value)) return violations;
  if (!publicHttpsUrl(value.publicPolicyUrl))
    violations.push(`${name}.publicPolicyUrl must be a public HTTPS URL`);
  if (!nonEmptyString(value.scope)) violations.push(`${name}.scope is required`);
  return violations;
}

function securityViolations(value, asOf) {
  const name = 'securityReporting';
  const violations = approvalViolations(name, value, asOf);
  if (!isRecord(value)) return violations;
  if (!publicChannels(value.reportChannels, publicReportChannel)) {
    violations.push(`${name}.reportChannels must contain distinct public HTTPS or mailto channels`);
  }
  if (!publicHttpsUrl(value.disclosurePolicyUrl)) {
    violations.push(`${name}.disclosurePolicyUrl must be a public HTTPS URL`);
  }
  if (!publicHttpsUrl(value.supportedVersionsPolicyUrl)) {
    violations.push(`${name}.supportedVersionsPolicyUrl must be a public HTTPS URL`);
  }
  return violations;
}

function supportViolations(value, asOf) {
  const name = 'supportPolicy';
  const violations = approvalViolations(name, value, asOf);
  if (!isRecord(value)) return violations;
  if (!publicChannels(value.channels, publicReportChannel)) {
    violations.push(`${name}.channels must contain distinct public HTTPS or mailto channels`);
  }
  if (!publicHttpsUrl(value.publicPolicyUrl)) {
    violations.push(`${name}.publicPolicyUrl must be a public HTTPS URL`);
  }
  if (!nonEmptyString(value.scope)) violations.push(`${name}.scope is required`);
  if (!nonEmptyString(value.responseTarget)) violations.push(`${name}.responseTarget is required`);
  return violations;
}

/**
 * Validates the release-owner facts required before a public commercial
 * distribution makes privacy, security-reporting or support promises. It does
 * not decide whether a policy is legally sufficient or an endpoint is staffed.
 */
export function releaseServiceRecordViolations(
  record,
  { mode = 'record', asOf = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!isRecord(record)) return ['Release service record is not an object'];
  const violations = [];
  if (record.schemaVersion !== 1) violations.push('Release service record schemaVersion must be 1');
  if (!['pending', 'active'].includes(record.status)) {
    violations.push('Release service record status must be pending or active');
    return violations;
  }

  if (record.status === 'pending') {
    for (const field of ['privacyAndDataHandling', 'securityReporting', 'supportPolicy']) {
      if (record[field] !== null) violations.push(`pending record must leave ${field} null`);
    }
    if (mode === 'active') {
      violations.push(
        'Release service record is pending; public privacy, security-reporting and support approvals are required',
      );
    }
    return violations.sort();
  }

  const effectiveAsOf = validIsoDate(asOf) ? asOf : new Date().toISOString().slice(0, 10);
  violations.push(...privacyViolations(record.privacyAndDataHandling, effectiveAsOf));
  violations.push(...securityViolations(record.securityReporting, effectiveAsOf));
  violations.push(...supportViolations(record.supportPolicy, effectiveAsOf));
  return violations.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modeByArgument = new Map([
    ['--check', 'record'],
    ['--active-check', 'active'],
  ]);
  const mode = modeByArgument.get(process.argv[2]);
  if (!mode || process.argv.length !== 3) {
    console.error(
      'Usage: node scripts/commercialization/release-service-record.mjs --check|--active-check',
    );
    process.exitCode = 2;
  } else if (!existsSync(recordPath)) {
    console.error(`Missing release service record: ${recordPath}`);
    process.exitCode = 1;
  } else {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const violations = releaseServiceRecordViolations(record, { mode });
    if (violations.length > 0) {
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(
        mode === 'record'
          ? `Release service record is valid in ${record.status} state.`
          : 'Release service record passes the active gate.',
      );
    }
  }
}
