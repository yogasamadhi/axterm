import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const recordPath = resolve(repositoryRoot, 'compliance/MINIMUM_COMMERCIAL_RELEASE_RECORD.json');

// These are byte/content hygiene checks, not substitute approvals. The old
// final-public gate remains available for the full three-platform program.
export const minimumTechnicalScripts = Object.freeze([
  'migration:record:removal-check',
  'licenses:components:check',
  'licenses:texts:check',
  'assets:check',
  'locales:check',
  'locales:core:check',
  'transition:boundaries:check',
  'snapshot:final-public:check',
]);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoDay(value, asOf) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value > asOf)
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function publicHttps(value) {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const ipHost = host.replace(/^\[/u, '').replace(/\]$/u, '');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !isIP(ipHost) &&
      !['localhost', '::1'].includes(host) &&
      !host.startsWith('127.') &&
      !['.local', '.test', '.invalid', '.example', '.internal'].some((suffix) =>
        host.endsWith(suffix),
      ) &&
      !host.includes('example.') &&
      ![...url.searchParams.keys()].some((key) =>
        /(?:token|secret|password|credential|signature|api[-_]?key|auth)/iu.test(key),
      )
    );
  } catch {
    return false;
  }
}

function evidence(value) {
  return Array.isArray(value) && value.length > 0 && value.every(text);
}

function required(target, fields, label, violations) {
  for (const field of fields) {
    if (!text(target[field])) violations.push(`${label}.${field} is required`);
  }
}

function approval(target, label, asOf, violations) {
  required(target, ['approvedBy'], label, violations);
  if (!isoDay(target.approvedAt, asOf))
    violations.push(`${label}.approvedAt must be a current-or-past ISO date`);
  if (!evidence(target.evidence)) violations.push(`${label}.evidence is required`);
}

/**
 * @param {any} record
 * @param {{ headCommit?: string | null, asOf?: string }} [options]
 */
export function minimumReleaseRecordViolations(
  record,
  { headCommit, asOf = new Date().toISOString().slice(0, 10) } = {},
) {
  if (!object(record)) return ['release record is missing or invalid'];
  const violations = [];
  if (record.schemaVersion !== 1) violations.push('schemaVersion must be 1');
  if (!/^[0-9a-f]{40}$/u.test(headCommit ?? ''))
    violations.push('current Git commit is unavailable');

  const rights = record.contentRights;
  if (!object(rights)) {
    violations.push('MCR-01 content-rights decision is pending');
  } else {
    approval(rights, 'contentRights', asOf, violations);
    required(
      rights,
      ['contributorAuthority', 'sourceLineageDecision', 'assetAndLocaleDecision', 'noticeDecision'],
      'contentRights',
      violations,
    );
  }

  const mac = record.macDelivery;
  if (!object(mac)) {
    violations.push('MCR-02 signed, notarized and downloaded Mac evidence is pending');
  } else {
    required(
      mac,
      ['notarizationId', 'appPath', 'appAsarPath', 'dmgPath', 'downloadedDmgPath'],
      'macDelivery',
      violations,
    );
    if (!/^[A-Z0-9]{10}$/u.test(mac.developerIdTeamId ?? ''))
      violations.push('macDelivery.developerIdTeamId must be a ten-character Apple Team ID');
    if (mac.sourceCommit !== headCommit)
      violations.push('macDelivery.sourceCommit must equal current Git commit');
    for (const field of ['appSha256', 'dmgSha256', 'downloadedSha256']) {
      if (!sha256(mac[field])) violations.push(`macDelivery.${field} must be SHA-256`);
    }
    if (sha256(mac.dmgSha256) && mac.downloadedSha256 !== mac.dmgSha256)
      violations.push('downloaded Mac DMG hash must match the released DMG');
    if (!publicHttps(mac.downloadUrl))
      violations.push('macDelivery.downloadUrl must be public HTTPS');
    if (!evidence(mac.gatekeeperAndInstallEvidence))
      violations.push('macDelivery.gatekeeperAndInstallEvidence is required');
    if (!evidence(mac.terminalAndSshEvidence))
      violations.push('macDelivery.terminalAndSshEvidence is required');
    if (!evidence(mac.legalTextEvidence))
      violations.push('macDelivery.legalTextEvidence is required');
  }

  const access = record.publicAccess;
  if (!object(access)) {
    violations.push('MCR-03 public repository, download and user-policy evidence is pending');
  } else {
    for (const field of [
      'repositoryUrl',
      'releaseUrl',
      'privacyUrl',
      'securityUrl',
      'supportUrl',
    ]) {
      if (!publicHttps(access[field]))
        violations.push(`publicAccess.${field} must be public HTTPS`);
    }
    if (access.updateMode !== 'manual')
      violations.push('publicAccess.updateMode must be manual for the first release');
    if (access.windowsLinuxStatus !== 'owner-self-test-pending')
      violations.push('publicAccess.windowsLinuxStatus must remain owner-self-test-pending');
    if (!evidence(access.evidence)) violations.push('publicAccess.evidence is required');
  }

  const owner = record.ownerAcceptance;
  if (!object(owner)) {
    violations.push('MCR-04 owner acceptance is pending');
  } else {
    approval(owner, 'ownerAcceptance', asOf, violations);
    if (owner.sourceCommit !== headCommit)
      violations.push('ownerAcceptance.sourceCommit must equal current Git commit');
    if (!sha256(owner.dmgSha256) || owner.dmgSha256 !== mac?.dmgSha256)
      violations.push('ownerAcceptance.dmgSha256 must match the approved Mac DMG');
    if (owner.windowsLinuxStatus !== 'owner-self-test-pending')
      violations.push('ownerAcceptance.windowsLinuxStatus must remain owner-self-test-pending');
    if (!Array.isArray(owner.unresolvedRisks) || !owner.unresolvedRisks.every(text))
      violations.push('ownerAcceptance.unresolvedRisks must be an explicit string list');
  }

  return violations;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Read-only local byte, Gatekeeper, signing and stapling checks for MCR-02.
 * @param {any} mac
 * @param {{ runCommand?: (command: string, argumentsList: string[]) => number, inspectSignature?: (app: string) => string }} [options]
 */
export function macArtifactViolations(mac, { runCommand, inspectSignature } = {}) {
  if (!object(mac)) return [];
  const paths = ['appPath', 'appAsarPath', 'dmgPath', 'downloadedDmgPath'];
  if (paths.some((field) => !text(mac[field]))) return [];
  const violations = [];
  const app = resolve(mac.appPath);
  const asar = resolve(mac.appAsarPath);
  const dmg = resolve(mac.dmgPath);
  const downloaded = resolve(mac.downloadedDmgPath);
  if (relative(app, asar).startsWith('..') || relative(app, asar) === '')
    violations.push('app.asar must be inside the checked application bundle');
  if (dmg === downloaded)
    violations.push('downloaded DMG must be a separate file from the local build');
  for (const [path, expected, label] of [
    [asar, mac.appSha256, 'app.asar'],
    [dmg, mac.dmgSha256, 'local DMG'],
    [downloaded, mac.downloadedSha256, 'downloaded DMG'],
  ]) {
    if (!existsSync(path)) {
      violations.push(`${label} is missing`);
      continue;
    }
    try {
      if (hashFile(path) !== expected)
        violations.push(`${label} SHA-256 does not match the record`);
    } catch {
      violations.push(`${label} cannot be read`);
    }
  }
  if (!existsSync(app)) violations.push('Mac application bundle is missing');
  if (violations.length > 0) return violations;
  try {
    if (realpathSync(dmg) === realpathSync(downloaded))
      return ['downloaded DMG must not resolve to the local build file'];
  } catch {
    return ['Mac DMG paths could not be resolved'];
  }
  try {
    const signature = inspectSignature(app);
    if (
      !/Authority=Developer ID Application:/u.test(signature) ||
      !signature.includes(`TeamIdentifier=${mac.developerIdTeamId}`)
    )
      violations.push('Mac app lacks the recorded Developer ID Application signature');
  } catch {
    violations.push('Mac app signing identity could not be inspected');
  }
  const checks = [
    ['codesign', ['--verify', '--deep', '--strict', app], 'Developer ID code-sign verification'],
    ['spctl', ['--assess', '--type', 'execute', app], 'Gatekeeper assessment'],
    ['xcrun', ['stapler', 'validate', app], 'application notarization ticket'],
    ['xcrun', ['stapler', 'validate', downloaded], 'downloaded DMG notarization ticket'],
    ['hdiutil', ['verify', downloaded], 'downloaded DMG checksum'],
  ];
  for (const [command, args, label] of checks) {
    try {
      if (runCommand(command, args) !== 0) violations.push(`${label} failed`);
    } catch {
      violations.push(`${label} could not run`);
    }
  }
  return violations;
}

/**
 * @param {{
 *   record: any,
 *   headCommit: string | null,
 *   runGate: (script: string) => { exitCode: number },
 *   verifyMac?: (mac: any) => string[],
 *   asOf?: string,
 * }} options
 */
export function runMinimumCommercialReleaseChecks({
  record,
  headCommit,
  runGate,
  verifyMac,
  asOf,
}) {
  const technicalResults = minimumTechnicalScripts.map((script) => {
    try {
      const result = runGate(script);
      return { script, exitCode: result?.exitCode === 0 ? 0 : 1 };
    } catch {
      return { script, exitCode: 1 };
    }
  });
  const blockingScripts = technicalResults
    .filter(({ exitCode }) => exitCode !== 0)
    .map(({ script }) => script);
  const recordViolations = minimumReleaseRecordViolations(record, { headCommit, asOf });
  if (object(record?.macDelivery)) {
    if (typeof verifyMac !== 'function')
      recordViolations.push('MCR-02 local Mac artifact verification is unavailable');
    else recordViolations.push(...verifyMac(record.macDelivery));
  }
  return {
    exitCode: blockingScripts.length || recordViolations.length ? 1 : 0,
    technicalResults,
    blockingScripts,
    recordViolations,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv
    .slice(2)
    .filter((argument, index) => !(index === 0 && argument === '--'));
  const validArgs =
    (args.length === 1 && args[0] === '--check') ||
    (args.length === 3 && args[0] === '--check' && args[1] === '--record' && text(args[2]));
  if (!validArgs) {
    console.error(
      'Usage: node scripts/commercialization/check-minimum-commercial-release.mjs --check [--record <external-approval.json>]',
    );
    process.exitCode = 2;
  } else {
    let record;
    try {
      record = JSON.parse(readFileSync(args[2] ? resolve(args[2]) : recordPath, 'utf8'));
    } catch {
      record = null;
    }
    const git = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    const outcome = runMinimumCommercialReleaseChecks({
      record,
      headCommit: git.status === 0 ? git.stdout.trim() : null,
      runGate(script) {
        const result = spawnSync('bun', ['run', script], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        return { exitCode: result.status ?? 1 };
      },
      verifyMac(mac) {
        return macArtifactViolations(mac, {
          inspectSignature(app) {
            const result = spawnSync('codesign', ['-dv', '--verbose=4', app], {
              encoding: 'utf8',
              maxBuffer: 8 * 1024 * 1024,
            });
            if (result.status !== 0) throw new Error('codesign inspection failed');
            return `${result.stdout}\n${result.stderr}`;
          },
          runCommand(command, commandArgs) {
            const result = spawnSync(command, commandArgs, {
              encoding: 'utf8',
              maxBuffer: 8 * 1024 * 1024,
            });
            return result.status ?? 1;
          },
        });
      },
    });
    for (const { script, exitCode } of outcome.technicalResults)
      console.log(`[${exitCode === 0 ? 'PASS' : 'BLOCKED'}] ${script}`);
    for (const violation of outcome.recordViolations) console.error(`[BLOCKED] ${violation}`);
    if (outcome.exitCode === 0)
      console.log(
        'Minimum commercial release evidence gate passed; human evidence remains subject to review.',
      );
    process.exitCode = outcome.exitCode;
  }
}
