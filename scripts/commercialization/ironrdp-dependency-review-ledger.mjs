import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { missingRootRecordViolations } from './ironrdp-missing-root-licenses.mjs';
import {
  ironRdpNestedLicenseViolations,
  tracingCoreSpinLicense,
} from './ironrdp-nested-license.mjs';
import { sourceHeaderRecordViolations } from './ironrdp-source-headers.mjs';

const root = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
);
const ledgerPath = resolve(root, 'compliance/IRONRDP_DEPENDENCY_REVIEW_LEDGER.json');
const missingRootPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.json',
);
const missingRootRecordSha256 = '91695e3bd448ff1464247288f1000f55314f39a7a0a17df934079dd313c24b3a';
const sourceHeaderRecordPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.json',
);
const sourceHeaderBundlePath = resolve(root, 'licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt');
const sourceHeaderRecordSha256 = '5b9fb5eea9d123bcbe5542c6690e0b9077d4ab2adf5c20b3a44694017eb28915';
const sourceHeaderBundleSha256 = 'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084';
const packageName = '@devolutions/iron-remote-desktop-rdp';
const packageVersion = '0.7.0';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pendingReview() {
  return {
    status: 'pending',
    reviewer: null,
    reviewedAt: null,
    evidence: [],
    conclusion: null,
    noticeDisposition: null,
  };
}

function retainedReview(value) {
  if (!record(value)) return pendingReview();
  return {
    status: value.status ?? 'pending',
    reviewer: value.reviewer ?? null,
    reviewedAt: value.reviewedAt ?? null,
    evidence: value.evidence ?? [],
    conclusion: value.conclusion ?? null,
    noticeDisposition: value.noticeDisposition ?? null,
  };
}

export function ironRdpReviewScope(inventory) {
  const violations = ironRdpNestedLicenseViolations(
    inventory,
    readFileSync(resolve(root, tracingCoreSpinLicense.packagedPath)),
  );
  if (violations.length) throw new Error(violations.join('; '));
  const missingRootBytes = readFileSync(missingRootPath);
  if (hash(missingRootBytes) !== missingRootRecordSha256)
    throw new Error('IronRDP publisher-root supplement differs from reviewed scope');
  const supplement = JSON.parse(missingRootBytes.toString('utf8'));
  const supplementViolations = missingRootRecordViolations(supplement, inventory);
  if (supplementViolations.length) throw new Error(supplementViolations.join('; '));
  const supplementalByIdentity = new Map(
    supplement.packages.map((entry) => [
      `${entry.name}@${entry.version}`,
      entry.rootLegalFiles.map(({ name, sha256 }) => ({ name, sha256 })),
    ]),
  );
  const sourceHeaderRecordBytes = readFileSync(sourceHeaderRecordPath);
  const sourceHeaderBundleBytes = readFileSync(sourceHeaderBundlePath);
  if (
    hash(sourceHeaderRecordBytes) !== sourceHeaderRecordSha256 ||
    hash(sourceHeaderBundleBytes) !== sourceHeaderBundleSha256
  ) {
    throw new Error('IronRDP source-header evidence differs from reviewed scope');
  }
  const sourceHeaderRecord = JSON.parse(sourceHeaderRecordBytes.toString('utf8'));
  const headerViolations = sourceHeaderRecordViolations(
    sourceHeaderRecord,
    inventory,
    sourceHeaderBundleBytes,
  );
  if (headerViolations.length) throw new Error(headerViolations.join('; '));
  const headerFilesByIdentity = new Map();
  for (const entry of sourceHeaderRecord.entries) {
    if (!headerFilesByIdentity.has(entry.package)) headerFilesByIdentity.set(entry.package, []);
    headerFilesByIdentity.get(entry.package).push({
      path: entry.path,
      fileSha256: entry.fileSha256,
      lineCount: entry.lines.length,
    });
  }
  const packages = inventory.packages.map((entry) => ({
    name: entry.name,
    version: entry.version,
    source: entry.source,
    ...(entry.source === 'registry' ? { checksum: entry.checksum } : { path: entry.path }),
    license: entry.license,
    rootLegalFiles: entry.rootLegalFiles,
    ...(supplementalByIdentity.has(`${entry.name}@${entry.version}`)
      ? { publisherRootLegalFiles: supplementalByIdentity.get(`${entry.name}@${entry.version}`) }
      : {}),
    ...(entry.name === tracingCoreSpinLicense.name &&
    entry.version === tracingCoreSpinLicense.version
      ? {
          nestedLegalFiles: [
            {
              path: tracingCoreSpinLicense.sourcePath,
              sha256: tracingCoreSpinLicense.sha256,
              packagedPath: tracingCoreSpinLicense.packagedPath,
            },
          ],
        }
      : {}),
    ...(headerFilesByIdentity.has(`${entry.name}@${entry.version}`)
      ? {
          sourceHeaderCandidates: {
            fileCount: headerFilesByIdentity.get(`${entry.name}@${entry.version}`).length,
            lineCount: headerFilesByIdentity
              .get(`${entry.name}@${entry.version}`)
              .reduce((count, file) => count + file.lineCount, 0),
            digest: hash(
              JSON.stringify(headerFilesByIdentity.get(`${entry.name}@${entry.version}`)),
            ),
          },
        }
      : {}),
  }));
  packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  return packages;
}

export function ironRdpReviewScopeSha256(inventory) {
  return hash(
    JSON.stringify({
      source: inventory.source,
      target: inventory.target,
      rootPackage: inventory.rootPackage,
      packages: ironRdpReviewScope(inventory),
      publishedEmbeddedWasmSha256: inventory.publishedEmbeddedWasmSha256,
    }),
  );
}

function expectedBinary(inventory) {
  return {
    name: packageName,
    version: packageVersion,
    embeddedWasmSha256: inventory.publishedEmbeddedWasmSha256,
  };
}

export function ironRdpReviewLedgerFromInventory(inventory, existing) {
  const packages = ironRdpReviewScope(inventory);
  const previous = new Map(
    Array.isArray(existing?.entries)
      ? existing.entries
          .filter((entry) => record(entry?.package))
          .map((entry) => [JSON.stringify(entry.package), entry.review])
      : [],
  );
  const binary = expectedBinary(inventory);
  return {
    schemaVersion: 1,
    source: 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
    sourceScopeSha256: ironRdpReviewScopeSha256(inventory),
    scope:
      'Target-rooted IronRDP wasm32 normal/build source candidates and published embedded WASM.',
    limitations: [
      'This is a qualified human-review queue, not an automatic license or source-to-WASM conclusion.',
      'Build-time/proc-macro source inclusion does not prove runtime linkage into the published WASM.',
      'A reproducible WASM build, nested/file-level rights review and final platform artifact checks remain separate requirements.',
    ],
    publishedWasm: {
      ...binary,
      review:
        JSON.stringify({
          name: existing?.publishedWasm?.name,
          version: existing?.publishedWasm?.version,
          embeddedWasmSha256: existing?.publishedWasm?.embeddedWasmSha256,
        }) === JSON.stringify(binary)
          ? retainedReview(existing.publishedWasm.review)
          : pendingReview(),
    },
    entries: packages.map((component) => ({
      package: component,
      review: retainedReview(previous.get(JSON.stringify(component))),
    })),
  };
}

function reviewViolations(label, value, requireReviewed) {
  if (!record(value) || !['pending', 'reviewed', 'needs-follow-up'].includes(value.status))
    return [`${label}: invalid review status`];
  if (value.status === 'pending') {
    const clean =
      value.reviewer === null &&
      value.reviewedAt === null &&
      Array.isArray(value.evidence) &&
      value.evidence.length === 0 &&
      value.conclusion === null &&
      value.noticeDisposition === null;
    return [
      ...(clean ? [] : [`${label}: pending review claims evidence or disposition`]),
      ...(requireReviewed ? [`${label}: review is pending`] : []),
    ];
  }
  const violations = [];
  if (!filled(value.reviewer)) violations.push(`${label}: named reviewer is required`);
  if (typeof value.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.reviewedAt))
    violations.push(`${label}: ISO review date is required`);
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    !value.evidence.every((item) => record(item) && filled(item.reference) && filled(item.note))
  ) {
    violations.push(`${label}: primary evidence references and notes are required`);
  }
  if (!filled(value.conclusion)) violations.push(`${label}: explicit conclusion is required`);
  if (!['packaged', 'not-applicable'].includes(value.noticeDisposition))
    violations.push(`${label}: notice disposition is required`);
  if (requireReviewed && value.status !== 'reviewed')
    violations.push(`${label}: review is ${value.status}`);
  return violations;
}

export function ironRdpReviewLedgerViolations(ledger, inventory, { requireReviewed = false } = {}) {
  if (!record(ledger)) return ['IronRDP review ledger is not an object'];
  const violations = [];
  if (ledger.schemaVersion !== 1) violations.push('IronRDP review ledger schemaVersion differs');
  if (ledger.source !== 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json')
    violations.push('IronRDP review ledger source differs');
  if (ledger.sourceScopeSha256 !== ironRdpReviewScopeSha256(inventory))
    violations.push('IronRDP review ledger source scope has drifted');
  const packages = ironRdpReviewScope(inventory);
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== packages.length) {
    violations.push('IronRDP review ledger does not cover every source package');
    return violations;
  }
  for (let index = 0; index < packages.length; index += 1) {
    const component = packages[index];
    const entry = ledger.entries[index];
    const label = `${component.name}@${component.version}`;
    if (JSON.stringify(entry?.package) !== JSON.stringify(component))
      violations.push(`${label}: source package scope differs`);
    violations.push(...reviewViolations(label, entry?.review, requireReviewed));
  }
  const binary = expectedBinary(inventory);
  if (
    !record(ledger.publishedWasm) ||
    Object.entries(binary).some(([key, value]) => ledger.publishedWasm[key] !== value)
  ) {
    violations.push('Published IronRDP WASM identity differs');
  }
  violations.push(
    ...reviewViolations('published IronRDP WASM', ledger.publishedWasm?.review, requireReviewed),
  );
  return violations;
}

export async function serializeIronRdpReviewLedger(ledger) {
  return format(JSON.stringify(ledger), { parser: 'json', printWidth: 100 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--generate', '--check', '--reviewed-check'].includes(mode))
    throw new Error(
      'Usage: ironrdp-dependency-review-ledger.mjs --generate|--check|--reviewed-check',
    );
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const desktop = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));
  if (desktop.dependencies?.[packageName] !== packageVersion)
    throw new Error('IronRDP review scope differs from the production dependency');
  if (mode === '--generate') {
    let existing;
    try {
      existing = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    writeFileSync(
      ledgerPath,
      await serializeIronRdpReviewLedger(ironRdpReviewLedgerFromInventory(inventory, existing)),
    );
    console.log(`Updated ${ledgerPath}`);
  } else {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const violations = ironRdpReviewLedgerViolations(ledger, inventory, {
      requireReviewed: mode === '--reviewed-check',
    });
    if (violations.length) {
      console.error(`IronRDP source and WASM review has ${violations.length} violation(s):`);
      for (const violation of violations.slice(0, 20)) console.error(`- ${violation}`);
      if (violations.length > 20) console.error(`- ... and ${violations.length - 20} more`);
      process.exitCode = 1;
    } else {
      console.log(
        `IronRDP review ledger covers ${ledger.entries.length} packages and one published WASM (${mode === '--reviewed-check' ? 'reviewed' : 'pending/reviewed'}).`,
      );
    }
  }
}
