import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const recordPath = resolve(repositoryRoot, 'compliance/MIGRATION_RELEASE_RECORD.json');

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableVersionParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isLaterStableVersion(later, earlier) {
  const laterParts = stableVersionParts(later);
  const earlierParts = stableVersionParts(earlier);
  if (!laterParts || !earlierParts) return false;
  for (let index = 0; index < laterParts.length; index += 1) {
    if (laterParts[index] > earlierParts[index]) return true;
    if (laterParts[index] < earlierParts[index]) return false;
  }
  return false;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function dateAtUtc(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateAtLeastDaysAfter(later, earlier, days) {
  const minimum = dateAtUtc(earlier);
  minimum.setUTCDate(minimum.getUTCDate() + days);
  return dateAtUtc(later) >= minimum;
}

function nonEmptyReferences(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function releaseViolations(name, release, asOf) {
  if (!isRecord(release)) return [`${name} must be an object`];
  const violations = [];
  if (!nonEmptyString(release.version)) violations.push(`${name}.version is required`);
  else if (!stableVersionParts(release.version))
    violations.push(`${name}.version must be a stable semantic version`);
  if (!validIsoDate(release.publishedAt))
    violations.push(`${name}.publishedAt must be an ISO date`);
  else if (release.publishedAt > asOf) {
    violations.push(`${name}.publishedAt cannot be after the current UTC date`);
  }
  if (!/^[a-f0-9]{64}$/u.test(release.artifactSha256 ?? '')) {
    violations.push(`${name}.artifactSha256 must be a SHA-256`);
  }
  if (!nonEmptyReferences(release.evidence)) violations.push(`${name}.evidence is required`);
  return violations;
}

function windowViolations(window, publicRelease, asOf) {
  if (!isRecord(window)) return ['approvedWindow must be an object'];
  const violations = [];
  if (!Number.isInteger(window.minimumDays) || window.minimumDays <= 0) {
    violations.push('approvedWindow.minimumDays must be a positive integer');
  }
  if (!Number.isInteger(window.minimumStableReleases) || window.minimumStableReleases <= 0) {
    violations.push('approvedWindow.minimumStableReleases must be a positive integer');
  }
  if (!validIsoDate(window.removalNotBefore)) {
    violations.push('approvedWindow.removalNotBefore must be an ISO date');
  } else if (
    validIsoDate(publicRelease?.publishedAt) &&
    Number.isInteger(window.minimumDays) &&
    window.minimumDays > 0 &&
    !dateAtLeastDaysAfter(window.removalNotBefore, publicRelease.publishedAt, window.minimumDays)
  ) {
    violations.push('approvedWindow.removalNotBefore is earlier than the approved minimum days');
  }
  if (!nonEmptyString(window.approvedBy)) violations.push('approvedWindow.approvedBy is required');
  if (!validIsoDate(window.approvedAt))
    violations.push('approvedWindow.approvedAt must be an ISO date');
  else {
    if (window.approvedAt > asOf)
      violations.push('approvedWindow.approvedAt cannot be after the current UTC date');
    if (validIsoDate(publicRelease?.publishedAt) && window.approvedAt > publicRelease.publishedAt)
      violations.push('approvedWindow.approvedAt must not be after the public migration release');
  }
  if (!nonEmptyReferences(window.decisionEvidence)) {
    violations.push('approvedWindow.decisionEvidence is required');
  }
  const belowRecommendedBaseline =
    Number.isInteger(window.minimumDays) &&
    Number.isInteger(window.minimumStableReleases) &&
    (window.minimumDays < 90 || window.minimumStableReleases < 1);
  if (belowRecommendedBaseline && !nonEmptyString(window.exceptionRationale)) {
    violations.push(
      'approvedWindow.exceptionRationale is required below the recommended 90-day/one-stable-release baseline',
    );
  }
  if (!belowRecommendedBaseline && window.exceptionRationale !== null) {
    violations.push(
      'approvedWindow.exceptionRationale must be null when the recommended baseline is met or exceeded',
    );
  }
  return violations;
}

function supportViolations(support) {
  if (!isRecord(support)) return ['support must be an object'];
  const violations = [];
  if (!nonEmptyReferences(support.channels)) violations.push('support.channels is required');
  if (!nonEmptyString(support.scope)) violations.push('support.scope is required');
  return violations;
}

function removalViolations(removal, publicRelease, window, asOf) {
  if (!isRecord(removal)) return ['removalApproval must be an object'];
  const violations = [];
  if (!nonEmptyString(removal.removalReleaseVersion)) {
    violations.push('removalApproval.removalReleaseVersion is required');
  } else if (!stableVersionParts(removal.removalReleaseVersion)) {
    violations.push('removalApproval.removalReleaseVersion must be a stable semantic version');
  } else if (
    stableVersionParts(publicRelease?.version) &&
    !isLaterStableVersion(removal.removalReleaseVersion, publicRelease.version)
  ) {
    violations.push(
      'removalApproval.removalReleaseVersion must follow the public migration release',
    );
  }
  if (!validIsoDate(removal.confirmedAt)) {
    violations.push('removalApproval.confirmedAt must be an ISO date');
  } else if (
    validIsoDate(window?.removalNotBefore) &&
    removal.confirmedAt < window.removalNotBefore
  ) {
    violations.push('removalApproval.confirmedAt is earlier than removalNotBefore');
  } else if (removal.confirmedAt > asOf) {
    violations.push('removalApproval.confirmedAt cannot be after the current UTC date');
  }
  if (
    !Array.isArray(removal.stableReleaseMilestones) ||
    removal.stableReleaseMilestones.length === 0
  ) {
    violations.push('removalApproval.stableReleaseMilestones must be a non-empty array');
  } else {
    const distinctMilestones = new Set();
    for (const [index, milestone] of removal.stableReleaseMilestones.entries()) {
      const prefix = `removalApproval.stableReleaseMilestones[${index}]`;
      if (!isRecord(milestone)) {
        violations.push(`${prefix} must be an object`);
        continue;
      }
      if (!nonEmptyString(milestone.version)) violations.push(`${prefix}.version is required`);
      else if (milestone.version === publicRelease?.version) {
        violations.push(`${prefix}.version must differ from the public migration release`);
      } else if (!stableVersionParts(milestone.version)) {
        violations.push(`${prefix}.version must be a stable semantic version`);
      } else if (
        stableVersionParts(publicRelease?.version) &&
        !isLaterStableVersion(milestone.version, publicRelease.version)
      ) {
        violations.push(`${prefix}.version must follow the public migration release`);
      }
      if (
        stableVersionParts(milestone.version) &&
        stableVersionParts(removal.removalReleaseVersion) &&
        !isLaterStableVersion(removal.removalReleaseVersion, milestone.version)
      ) {
        violations.push(`${prefix}.version must precede the compatibility-removal release`);
      }
      if (!validIsoDate(milestone.publishedAt)) {
        violations.push(`${prefix}.publishedAt must be an ISO date`);
      } else {
        if (
          validIsoDate(publicRelease?.publishedAt) &&
          milestone.publishedAt <= publicRelease.publishedAt
        ) {
          violations.push(`${prefix} must be dated after the public migration release`);
        }
        if (validIsoDate(removal.confirmedAt) && milestone.publishedAt > removal.confirmedAt) {
          violations.push(`${prefix} is later than the removal approval`);
        }
      }
      if (!nonEmptyReferences(milestone.evidence))
        violations.push(`${prefix}.evidence is required`);
      if (
        stableVersionParts(milestone.version) &&
        isLaterStableVersion(milestone.version, publicRelease?.version) &&
        validIsoDate(milestone.publishedAt)
      ) {
        const versionKey = stableVersionParts(milestone.version).join('.');
        if (distinctMilestones.has(versionKey)) {
          violations.push(`${prefix}.version duplicates an earlier stable-release milestone`);
        } else {
          distinctMilestones.add(versionKey);
        }
      }
    }
    if (
      Number.isInteger(window?.minimumStableReleases) &&
      distinctMilestones.size < window.minimumStableReleases
    ) {
      violations.push(
        'removalApproval.stableReleaseMilestones does not satisfy approvedWindow.minimumStableReleases',
      );
    }
  }
  if (!nonEmptyString(removal.approvedBy))
    violations.push('removalApproval.approvedBy is required');
  if (!nonEmptyReferences(removal.evidence))
    violations.push('removalApproval.evidence is required');
  return violations;
}

function immediateRemovalViolations(record, mode, asOf) {
  const violations = [];
  if (record.status !== 'immediate-removal-approved') {
    violations.push('Immediate-removal record status must be immediate-removal-approved');
  }
  for (const field of ['publicMigrationRelease', 'approvedWindow', 'support', 'removalApproval']) {
    if (record[field] !== null)
      violations.push(`immediate-removal record must leave ${field} null`);
  }
  const approval = record.immediateRemovalApproval;
  if (!isRecord(approval)) {
    violations.push('immediateRemovalApproval must be an object');
  } else {
    if (!nonEmptyString(approval.approvedBy)) {
      violations.push('immediateRemovalApproval.approvedBy is required');
    }
    if (!validIsoDate(approval.approvedAt)) {
      violations.push('immediateRemovalApproval.approvedAt must be an ISO date');
    } else if (approval.approvedAt > asOf) {
      violations.push('immediateRemovalApproval.approvedAt cannot be after the current UTC date');
    }
    if (approval.priorPublicDistribution !== false) {
      violations.push('immediateRemovalApproval.priorPublicDistribution must be false');
    }
    if (approval.localDataPolicy !== 'preserve-inert') {
      violations.push('immediateRemovalApproval.localDataPolicy must be preserve-inert');
    }
    if (approval.remoteDataPolicy !== 'preserve') {
      violations.push('immediateRemovalApproval.remoteDataPolicy must be preserve');
    }
    if (
      !nonEmptyReferences(approval.decisionEvidence) ||
      !approval.decisionEvidence.includes(
        'docs/adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md',
      )
    ) {
      violations.push('immediateRemovalApproval.decisionEvidence must cite ADR-021');
    }
  }
  if (mode === 'active') {
    violations.push(
      'No public migration release exists under the approved immediate-removal decision',
    );
  }
  return violations.sort();
}

/**
 * Validates the owner-approved compatibility decision. Version 1 retains the
 * superseded migration-window record for historical audit; version 2 records
 * ADR-021's immediate removal. Neither substitutes for package, source-rights
 * or user-data evidence.
 */
export function migrationReleaseRecordViolations(
  record,
  { mode = 'record', asOf = new Date().toISOString().slice(0, 10) } = {},
) {
  const violations = [];
  if (!isRecord(record)) return ['Migration release record is not an object'];
  const effectiveAsOf = validIsoDate(asOf) ? asOf : new Date().toISOString().slice(0, 10);
  if (record.schemaVersion === 2) {
    return immediateRemovalViolations(record, mode, effectiveAsOf);
  }
  if (record.schemaVersion !== 1)
    violations.push('Migration release record schemaVersion must be 1 or 2');
  if (!['pending', 'active', 'removal-approved'].includes(record.status)) {
    violations.push('Migration release record status must be pending, active or removal-approved');
    return violations;
  }
  if (!isRecord(record.recommendedBaseline)) {
    violations.push('recommendedBaseline must be an object');
  } else if (
    record.recommendedBaseline.minimumDays !== 90 ||
    record.recommendedBaseline.minimumStableReleases !== 1 ||
    record.recommendedBaseline.rule !== 'later-of-duration-and-stable-release'
  ) {
    violations.push(
      'recommendedBaseline must retain the documented 90-day/one-stable-release default',
    );
  }

  if (record.status === 'pending') {
    for (const field of [
      'publicMigrationRelease',
      'approvedWindow',
      'support',
      'removalApproval',
    ]) {
      if (record[field] !== null) violations.push(`pending record must leave ${field} null`);
    }
    if (mode === 'active' || mode === 'removal') {
      violations.push(
        'Migration release record is pending; public migration release approval is required',
      );
    }
    return violations.sort();
  }

  violations.push(
    ...releaseViolations('publicMigrationRelease', record.publicMigrationRelease, effectiveAsOf),
  );
  violations.push(
    ...windowViolations(record.approvedWindow, record.publicMigrationRelease, effectiveAsOf),
  );
  violations.push(...supportViolations(record.support));

  if (record.status === 'active') {
    if (record.removalApproval !== null) {
      violations.push(
        'active record must leave removalApproval null until the migration window ends',
      );
    }
    if (mode === 'removal') {
      violations.push(
        'Migration release record is active; removal approval is required after the window ends',
      );
    }
  } else {
    violations.push(
      ...removalViolations(
        record.removalApproval,
        record.publicMigrationRelease,
        record.approvedWindow,
        effectiveAsOf,
      ),
    );
  }
  return violations.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modeByArgument = new Map([
    ['--check', 'record'],
    ['--active-check', 'active'],
    ['--removal-check', 'removal'],
  ]);
  const mode = modeByArgument.get(process.argv[2]);
  if (!mode || process.argv.length !== 3) {
    console.error(
      'Usage: node scripts/commercialization/migration-release-record.mjs --check|--active-check|--removal-check',
    );
    process.exitCode = 2;
  } else if (!existsSync(recordPath)) {
    console.error(`Missing migration release record: ${recordPath}`);
    process.exitCode = 1;
  } else {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    const violations = migrationReleaseRecordViolations(record, { mode });
    if (violations.length > 0) {
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(
        mode === 'record'
          ? `Migration release record is valid in ${record.status} state.`
          : `Migration release record passes the ${mode} gate.`,
      );
    }
  }
}
