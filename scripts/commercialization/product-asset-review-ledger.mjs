import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(repositoryRoot, 'compliance/AXTERM_PRODUCT_ASSETS.json');
const outputPath = resolve(repositoryRoot, 'compliance/PRODUCT_ASSET_REVIEW_LEDGER.json');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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

function assetIdentity(asset) {
  return `${asset.path}\0${asset.sha256}`;
}

export function productAssetReviewScope(inventory) {
  if (!isRecord(inventory) || inventory.schemaVersion !== 1 || !Array.isArray(inventory.assets)) {
    throw new Error('Unsupported product asset inventory');
  }
  return inventory.assets
    .map(({ path, sha256 }) => ({ path, sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
}

export function productAssetReviewScopeSha256(inventory) {
  const manifest = productAssetReviewScope(inventory)
    .map(({ path, sha256 }) => `${path}\0${sha256}`)
    .join('\n');
  return createHash('sha256').update(manifest).digest('hex');
}

function pendingReview() {
  return {
    status: 'pending',
    reviewer: null,
    reviewedAt: null,
    evidence: [],
    conclusion: null,
  };
}

function pendingEntry(asset) {
  return {
    asset,
    publicDisposition: 'pending',
    rightsReview: pendingReview(),
    brandReview: pendingReview(),
  };
}

function retainedEntry(asset, existing) {
  if (!isRecord(existing)) return pendingEntry(asset);
  return {
    asset,
    publicDisposition: existing.publicDisposition,
    rightsReview: existing.rightsReview,
    brandReview: existing.brandReview,
  };
}

/**
 * Creates a human-review handoff for Axterm's declared first-party product
 * marks. It deliberately excludes third-party fonts, runtime bundles, native
 * modules and WASM; their licenses require separate reviews.
 */
export function productAssetReviewLedgerFromInventoryWithExisting(inventory, existingLedger) {
  const existingByIdentity = new Map(
    Array.isArray(existingLedger?.entries)
      ? existingLedger.entries
          .filter((entry) => isRecord(entry) && isRecord(entry.asset))
          .map((entry) => [assetIdentity(entry.asset), entry])
      : [],
  );
  const scope = productAssetReviewScope(inventory);
  return {
    schemaVersion: 1,
    source: 'AXTERM_PRODUCT_ASSETS.json declared first-party product-mark assets',
    sourceScopeSha256: productAssetReviewScopeSha256(inventory),
    scope:
      'Declared first-party application marks only; excludes third-party, generated-runtime and package-managed assets.',
    limitations: [
      'This is a human-review handoff, not a copyright, trademark, license, authorship or freedom-to-operate conclusion.',
      'A retained entry does not clear platform package inspection, third-party font/bundle review, source-rights review or IR-07.',
      'Every retained application-mark asset needs an explicit retain or exclude decision before a final public source snapshot.',
    ],
    entries: scope.map((asset) =>
      retainedEntry(asset, existingByIdentity.get(assetIdentity(asset))),
    ),
  };
}

export function productAssetReviewLedgerFromInventory(inventory) {
  return productAssetReviewLedgerFromInventoryWithExisting(inventory, undefined);
}

function reviewViolations(assetPath, name, review, requireReviewed) {
  const prefix = `${assetPath}.${name}`;
  if (!isRecord(review) || !['pending', 'reviewed'].includes(review.status)) {
    return [`${prefix} must have a pending or reviewed status`];
  }
  if (review.status === 'pending') {
    const hasUnexpectedEvidence =
      review.reviewer !== null ||
      review.reviewedAt !== null ||
      review.conclusion !== null ||
      !Array.isArray(review.evidence) ||
      review.evidence.length !== 0;
    if (hasUnexpectedEvidence)
      return [`${prefix} pending review must not claim evidence or approval`];
    return requireReviewed ? [`${prefix} is pending`] : [];
  }
  const evidenceValid =
    Array.isArray(review.evidence) &&
    review.evidence.length > 0 &&
    review.evidence.every(nonEmptyString);
  if (
    !nonEmptyString(review.reviewer) ||
    !isoDate(review.reviewedAt) ||
    !evidenceValid ||
    !nonEmptyString(review.conclusion)
  ) {
    return [`${prefix} reviewed status requires reviewer, ISO date, evidence and conclusion`];
  }
  return [];
}

export function productAssetReviewLedgerViolations(
  ledger,
  inventory,
  { requireReviewed = false } = {},
) {
  const violations = [];
  if (!isRecord(ledger)) return ['Asset review ledger is not an object'];
  if (ledger.schemaVersion !== 1) violations.push('Asset review ledger schemaVersion must be 1');
  if (ledger.source !== 'AXTERM_PRODUCT_ASSETS.json declared first-party product-mark assets') {
    violations.push('Asset review ledger source is invalid');
  }
  if (ledger.sourceScopeSha256 !== productAssetReviewScopeSha256(inventory)) {
    violations.push(
      'Asset review ledger sourceScopeSha256 is stale; regenerate and preserve review evidence',
    );
  }
  const expectedScope = productAssetReviewScope(inventory);
  if (!Array.isArray(ledger.entries) || ledger.entries.length !== expectedScope.length) {
    violations.push('Asset review ledger entries do not match the current asset scope');
    return violations;
  }
  const expectedByPath = new Map(expectedScope.map((asset) => [asset.path, asset]));
  const seenPaths = new Set();
  for (const entry of ledger.entries) {
    if (!isRecord(entry) || !isRecord(entry.asset) || !nonEmptyString(entry.asset.path)) {
      violations.push('Asset review ledger has an invalid entry');
      continue;
    }
    const asset = expectedByPath.get(entry.asset.path);
    if (!asset || seenPaths.has(asset.path) || entry.asset.sha256 !== asset.sha256) {
      violations.push(
        `Asset review ledger entry does not match current asset: ${entry.asset.path}`,
      );
      continue;
    }
    seenPaths.add(asset.path);
    if (!['pending', 'retain', 'exclude'].includes(entry.publicDisposition)) {
      violations.push(`${asset.path}.publicDisposition must be pending, retain or exclude`);
    } else if (requireReviewed && entry.publicDisposition === 'pending') {
      violations.push(`${asset.path}.publicDisposition is pending`);
    }
    violations.push(
      ...reviewViolations(asset.path, 'rightsReview', entry.rightsReview, requireReviewed),
    );
    violations.push(
      ...reviewViolations(asset.path, 'brandReview', entry.brandReview, requireReviewed),
    );
  }
  for (const asset of expectedScope) {
    if (!seenPaths.has(asset.path))
      violations.push(`Asset review ledger is missing: ${asset.path}`);
  }
  return violations.sort(compareText);
}

export async function serializeProductAssetReviewLedger(ledger) {
  return format(JSON.stringify(ledger), { parser: 'json' });
}

async function currentLedger() {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const existing = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, 'utf8'))
    : undefined;
  return {
    inventory,
    ledger: productAssetReviewLedgerFromInventoryWithExisting(inventory, existing),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const { inventory, ledger } = await currentLedger();
  const text = await serializeProductAssetReviewLedger(ledger);
  if (mode === '--generate') {
    writeFileSync(outputPath, text);
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check' || mode === '--reviewed-check') {
    const requireReviewed = mode === '--reviewed-check';
    const existingText = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : undefined;
    const violations = productAssetReviewLedgerViolations(ledger, inventory, { requireReviewed });
    if (existingText !== text)
      violations.push('Asset review ledger is stale; run bun run assets:marks:generate');
    if (violations.length > 0) {
      for (const violation of violations) console.error(violation);
      process.exitCode = 1;
    } else {
      console.log(
        requireReviewed
          ? 'Reviewed product-mark asset ledger is ready for the scoped promotion gate.'
          : 'Product-mark asset review ledger matches the current asset scope.',
      );
    }
  } else {
    console.error(
      'Usage: node scripts/commercialization/product-asset-review-ledger.mjs --generate|--check|--reviewed-check',
    );
    process.exitCode = 2;
  }
}
