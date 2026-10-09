import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  fsSafeHeaderCandidatesByPackage,
  fsSafeSourceHeaderRecordViolations,
} from './fs-safe-source-headers.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const outputPath = resolve(repositoryRoot, 'compliance/NATIVE_DEPENDENCY_REVIEW_LEDGER.json');
const sourceHeaderRecordPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.json',
);
const sourceHeaderBundlePath = resolve(
  repositoryRoot,
  'licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt',
);
const sourceHeaderRecordSha256 = '013a6d6447d5650991da26fc134c3d5578a8c8f345a8934fcd54d5676f052c83';
const sourceHeaderBundleSha256 = '52186f73b215d7863766c152499f6bb2caea70187f8e6fe7165a4f6c65a95a8a';
const nativeBinary = {
  name: '@openclaw/fs-safe-darwin-arm64',
  version: '0.13.1',
  sha256: '78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0',
};

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function packageIdentity(value) {
  return `${value.name}@${value.version}`;
}

export function installedMacArm64NativeBinaryViolations(bytes) {
  return createHash('sha256').update(bytes).digest('hex') === nativeBinary.sha256
    ? []
    : ['Installed macOS arm64 native binding differs from the reviewed binary scope'];
}

function currentMacArm64NativeBinary() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return null;
  const desktopRequire = createRequire(resolve(repositoryRoot, 'apps/desktop/package.json'));
  const parentManifest = desktopRequire.resolve('@openclaw/fs-safe/package.json');
  const bindingRequire = createRequire(parentManifest);
  return readFileSync(bindingRequire.resolve(nativeBinary.name));
}

export function nativeReviewScope(inventory) {
  if (
    !isRecord(inventory) ||
    inventory.schemaVersion !== 1 ||
    inventory.target !== 'aarch64-apple-darwin' ||
    inventory.source?.commit !== '7022a0a10c53e36f34a467df68ed5614a1db1741' ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== inventory.packageCount
  ) {
    throw new Error('Unsupported native source inventory');
  }
  const headerRecordBytes = readFileSync(sourceHeaderRecordPath);
  const headerBundleBytes = readFileSync(sourceHeaderBundlePath);
  if (
    createHash('sha256').update(headerRecordBytes).digest('hex') !== sourceHeaderRecordSha256 ||
    createHash('sha256').update(headerBundleBytes).digest('hex') !== sourceHeaderBundleSha256
  ) {
    throw new Error('Native source-header evidence differs from reviewed scope');
  }
  const headerRecord = JSON.parse(headerRecordBytes.toString('utf8'));
  const headerViolations = fsSafeSourceHeaderRecordViolations(
    headerRecord,
    inventory,
    headerBundleBytes,
  );
  if (headerViolations.length) throw new Error(headerViolations.join('; '));
  const headersByPackage = fsSafeHeaderCandidatesByPackage(headerRecord);
  const packages = inventory.packages.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmpty(entry.name) ||
      !nonEmpty(entry.version) ||
      !nonEmpty(entry.license) ||
      !['registry', 'tag-source'].includes(entry.source) ||
      !Array.isArray(entry.rootLicenseFiles)
    ) {
      throw new Error('Invalid native source package');
    }
    if (
      !entry.rootLicenseFiles.every(
        (file) =>
          isRecord(file) &&
          /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[._-].*)?$/iu.test(file.name) &&
          typeof file.sha256 === 'string' &&
          /^[a-f0-9]{64}$/u.test(file.sha256),
      ) ||
      new Set(entry.rootLicenseFiles.map((file) => file.name)).size !==
        entry.rootLicenseFiles.length
    ) {
      throw new Error(`Invalid native root legal-file inventory: ${packageIdentity(entry)}`);
    }
    return {
      name: entry.name,
      version: entry.version,
      license: entry.license,
      source: entry.source,
      rootLicenseFiles: entry.rootLicenseFiles,
      ...(headersByPackage.has(`${entry.name}@${entry.version}`)
        ? { sourceHeaderCandidates: headersByPackage.get(`${entry.name}@${entry.version}`) }
        : {}),
    };
  });
  packages.sort((left, right) => packageIdentity(left).localeCompare(packageIdentity(right)));
  if (new Set(packages.map(packageIdentity)).size !== packages.length)
    throw new Error('Duplicate native source package');
  return packages;
}

export function nativeReviewScopeSha256(inventory) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: inventory.source,
        target: inventory.target,
        packages: nativeReviewScope(inventory),
        nativeBinary,
      }),
    )
    .digest('hex');
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

function retainReview(existing) {
  if (!isRecord(existing)) return pendingReview();
  return {
    status: existing.status ?? 'pending',
    reviewer: existing.reviewer ?? null,
    reviewedAt: existing.reviewedAt ?? null,
    evidence: existing.evidence ?? [],
    conclusion: existing.conclusion ?? null,
    noticeDisposition: existing.noticeDisposition ?? null,
  };
}

export function nativeReviewLedgerFromInventory(inventory, existing) {
  const expected = nativeReviewScope(inventory);
  const previous = new Map(
    Array.isArray(existing?.entries)
      ? existing.entries
          .filter((entry) => isRecord(entry?.package))
          .map((entry) => [JSON.stringify(entry.package), entry.review])
      : [],
  );
  return {
    schemaVersion: 1,
    source: 'IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
    sourceScopeSha256: nativeReviewScopeSha256(inventory),
    scope: 'Pinned fs-safe macOS arm64 Cargo normal-source graph and published native binary.',
    limitations: [
      'This is a qualified human-review handoff, not an automatic legal or binary-provenance conclusion.',
      'The Cargo normal graph includes compile-time proc macros and may not equal the exact linked binary contents.',
      'Windows and Linux require separate target-native dependency and packaged-artifact reviews.',
    ],
    nativeBinary: {
      ...nativeBinary,
      review:
        existing?.sourceScopeSha256 === nativeReviewScopeSha256(inventory) &&
        existing?.nativeBinary?.sha256 === nativeBinary.sha256
          ? retainReview(existing.nativeBinary.review)
          : pendingReview(),
    },
    entries: expected.map((component) => ({
      package: component,
      review: retainReview(previous.get(JSON.stringify(component))),
    })),
  };
}

function reviewViolations(label, review, requireReviewed) {
  if (!isRecord(review) || !['pending', 'reviewed', 'needs-follow-up'].includes(review.status))
    return [`${label}: review status is invalid`];
  if (review.status === 'pending') {
    const clean =
      review.reviewer === null &&
      review.reviewedAt === null &&
      Array.isArray(review.evidence) &&
      review.evidence.length === 0 &&
      review.conclusion === null &&
      review.noticeDisposition === null;
    return [
      ...(clean ? [] : [`${label}: pending review must not claim evidence or disposition`]),
      ...(requireReviewed ? [`${label}: review is pending`] : []),
    ];
  }
  const violations = [];
  if (!nonEmpty(review.reviewer)) violations.push(`${label}: named reviewer is required`);
  if (typeof review.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(review.reviewedAt))
    violations.push(`${label}: ISO review date is required`);
  if (
    !Array.isArray(review.evidence) ||
    review.evidence.length === 0 ||
    !review.evidence.every(
      (item) => isRecord(item) && nonEmpty(item.reference) && nonEmpty(item.note),
    )
  )
    violations.push(`${label}: primary evidence references and notes are required`);
  if (!nonEmpty(review.conclusion)) violations.push(`${label}: explicit conclusion is required`);
  if (!['packaged', 'not-applicable'].includes(review.noticeDisposition))
    violations.push(`${label}: notice disposition must be packaged or not-applicable`);
  if (requireReviewed && review.status !== 'reviewed')
    violations.push(`${label}: review is ${review.status}`);
  return violations;
}

export function nativeReviewLedgerViolations(ledger, inventory, { requireReviewed = false } = {}) {
  if (!isRecord(ledger)) return ['Native review ledger is not an object'];
  const violations = [];
  if (ledger.schemaVersion !== 1) violations.push('Native review ledger schemaVersion must be 1');
  if (ledger.source !== 'IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json')
    violations.push('Native review ledger source is invalid');
  if (ledger.sourceScopeSha256 !== nativeReviewScopeSha256(inventory))
    violations.push('Native review ledger source scope has drifted');
  const expected = nativeReviewScope(inventory);
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== expected.length) {
    violations.push('Native review ledger does not cover every source package');
    return violations;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = ledger.entries[index];
    const component = expected[index];
    if (JSON.stringify(entry?.package) !== JSON.stringify(component))
      violations.push(`${packageIdentity(component)}: source package scope differs`);
    violations.push(
      ...reviewViolations(packageIdentity(component), entry?.review, requireReviewed),
    );
  }
  if (
    !isRecord(ledger.nativeBinary) ||
    ledger.nativeBinary.name !== nativeBinary.name ||
    ledger.nativeBinary.version !== nativeBinary.version ||
    ledger.nativeBinary.sha256 !== nativeBinary.sha256
  )
    violations.push('Published macOS native binary identity differs');
  violations.push(
    ...reviewViolations(
      'published macOS native binary',
      ledger.nativeBinary?.review,
      requireReviewed,
    ),
  );
  return violations;
}

export async function serializeNativeReviewLedger(ledger) {
  return format(JSON.stringify(ledger), { parser: 'json', printWidth: 100 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--generate', '--check', '--reviewed-check'].includes(mode)) {
    console.error(
      'Usage: node scripts/commercialization/native-dependency-review-ledger.mjs --generate|--check|--reviewed-check',
    );
    process.exitCode = 2;
  } else {
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    const runtimeManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'packages/runtime/package.json'), 'utf8'),
    );
    const desktopManifest = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'apps/desktop/package.json'), 'utf8'),
    );
    if (
      runtimeManifest.dependencies?.['@openclaw/fs-safe'] !== '0.13.1' ||
      desktopManifest.dependencies?.['@openclaw/fs-safe'] !== '0.13.1'
    ) {
      throw new Error('Native source review scope no longer matches exact production dependency');
    }
    if (mode === '--generate') {
      let existing;
      try {
        existing = JSON.parse(readFileSync(outputPath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      writeFileSync(
        outputPath,
        await serializeNativeReviewLedger(nativeReviewLedgerFromInventory(inventory, existing)),
      );
      console.log(`Updated ${outputPath}`);
    } else {
      const ledger = JSON.parse(readFileSync(outputPath, 'utf8'));
      const violations = nativeReviewLedgerViolations(ledger, inventory, {
        requireReviewed: mode === '--reviewed-check',
      });
      const installedBinary = currentMacArm64NativeBinary();
      if (installedBinary)
        violations.push(...installedMacArm64NativeBinaryViolations(installedBinary));
      if (violations.length > 0) {
        console.error(`Native dependency review ledger has ${violations.length} violation(s):`);
        for (const violation of violations) console.error(`- ${violation}`);
        process.exitCode = 1;
      } else {
        console.log(
          `Native dependency review ledger covers ${ledger.entries.length} packages and one binary (${mode === '--reviewed-check' ? 'reviewed' : 'pending/reviewed'}).`,
        );
      }
    }
  }
}
