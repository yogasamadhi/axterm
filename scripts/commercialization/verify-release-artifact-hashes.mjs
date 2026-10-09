import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseArtifactHashManifest } from './generate-release-artifact-hashes.mjs';

function readManifest(path) {
  const resolvedPath = resolve(path);
  let contents;
  try {
    if (!statSync(resolvedPath).isFile()) {
      throw new Error('path is not a regular file');
    }
    contents = readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Release artifact hash manifest cannot be read: ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return { manifest: JSON.parse(contents), resolvedPath };
  } catch (error) {
    throw new Error(
      `Release artifact hash manifest is not valid JSON: ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function artifactMap(artifacts, label, differences) {
  if (!Array.isArray(artifacts)) {
    differences.push(`${label}.artifacts is not an array`);
    return new Map();
  }
  const result = new Map();
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.path !== 'string') {
      differences.push(`${label}.artifacts contains an entry without a string path`);
      continue;
    }
    if (result.has(artifact.path)) {
      differences.push(`${label}.artifacts contains duplicate path ${artifact.path}`);
      continue;
    }
    result.set(artifact.path, artifact);
  }
  return result;
}

function manifestDifferences(actual, expected) {
  const differences = [];
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    return ['manifest root is not an object'];
  }
  if (actual.schemaVersion !== expected.schemaVersion) {
    differences.push(
      `schemaVersion is ${JSON.stringify(actual.schemaVersion)}; expected ${expected.schemaVersion}`,
    );
  }
  if (!isDeepStrictEqual(actual.product, expected.product)) {
    differences.push(
      `product is ${JSON.stringify(actual.product)}; expected ${JSON.stringify(expected.product)}`,
    );
  }
  if (actual.platform !== expected.platform) {
    differences.push(
      `platform is ${JSON.stringify(actual.platform)}; expected ${JSON.stringify(expected.platform)}`,
    );
  }

  const actualArtifacts = artifactMap(actual.artifacts, 'manifest', differences);
  const expectedArtifacts = artifactMap(expected.artifacts, 'generated manifest', differences);
  if (
    Array.isArray(actual.artifacts) &&
    !isDeepStrictEqual(
      actual.artifacts.map((artifact) => artifact?.path),
      expected.artifacts.map((artifact) => artifact.path),
    )
  ) {
    differences.push('artifact paths are not in deterministic generated order');
  }
  for (const [path, expectedArtifact] of expectedArtifacts) {
    const actualArtifact = actualArtifacts.get(path);
    if (!actualArtifact) {
      differences.push(`artifact is missing from manifest: ${path}`);
      continue;
    }
    if (actualArtifact.bytes !== expectedArtifact.bytes) {
      differences.push(
        `${path} byte count is ${JSON.stringify(actualArtifact.bytes)}; current artifact is ${expectedArtifact.bytes}`,
      );
    }
    if (actualArtifact.sha256 !== expectedArtifact.sha256) {
      differences.push(
        `${path} SHA-256 is ${JSON.stringify(actualArtifact.sha256)}; current artifact is ${expectedArtifact.sha256}`,
      );
    }
    for (const key of Object.keys(actualArtifact)) {
      if (!Object.hasOwn(expectedArtifact, key)) {
        differences.push(`${path} contains unexpected field: ${key}`);
      }
    }
    for (const key of Object.keys(expectedArtifact)) {
      if (!Object.hasOwn(actualArtifact, key)) {
        differences.push(`${path} is missing field: ${key}`);
      }
    }
  }
  for (const path of actualArtifacts.keys()) {
    if (!expectedArtifacts.has(path))
      differences.push(`manifest contains absent artifact: ${path}`);
  }
  if (!isDeepStrictEqual(actual.limitations, expected.limitations)) {
    differences.push('limitations do not match the generated release-artifact policy');
  }
  for (const key of Object.keys(actual)) {
    if (!Object.hasOwn(expected, key))
      differences.push(`manifest contains unexpected field: ${key}`);
  }
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(actual, key)) differences.push(`manifest is missing field: ${key}`);
  }
  return differences;
}

export function verifyReleaseArtifactHashManifest(
  releaseDirectory,
  manifestPath,
  platform,
  product,
) {
  const { manifest, resolvedPath } = readManifest(manifestPath);
  const expected = releaseArtifactHashManifest(releaseDirectory, platform, product);
  const differences = manifestDifferences(manifest, expected);
  if (differences.length > 0) {
    throw new Error(
      `Release artifact hash manifest does not match current distributable bytes: ${resolvedPath}\n${differences.map((difference) => `- ${difference}`).join('\n')}`,
    );
  }
  return expected;
}

export function releaseArtifactVerificationReceipt(manifestPath, verifiedManifest) {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestBytes = readFileSync(resolvedManifestPath);
  return {
    schemaVersion: 1,
    verification: 'release-artifact-byte-verification',
    product: verifiedManifest.product,
    platform: verifiedManifest.platform,
    manifest: {
      path: basename(resolvedManifestPath),
      bytes: manifestBytes.byteLength,
      sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    },
    artifacts: verifiedManifest.artifacts,
    limitations: [
      'This receipt records that the named local distributable files matched the named manifest when the verifier ran.',
      'Workflow placement determines whether those local files came from an artifact download; this receipt alone does not prove their transport origin.',
      'This is not a signature, notarization, transparency-log entry, public-download verification, source-rights review or release approval.',
    ],
  };
}

function writeVerificationReceipt(receiptPath, releaseDirectory, manifestPath, verifiedManifest) {
  const resolvedReceiptPath = resolve(receiptPath);
  const protectedPaths = new Set([
    resolve(manifestPath),
    ...verifiedManifest.artifacts.map((artifact) => resolve(releaseDirectory, artifact.path)),
  ]);
  if (protectedPaths.has(resolvedReceiptPath)) {
    throw new Error(
      `Verification receipt must not overwrite the manifest or a verified artifact: ${resolvedReceiptPath}`,
    );
  }
  const receipt = releaseArtifactVerificationReceipt(manifestPath, verifiedManifest);
  writeFileSync(resolvedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return resolvedReceiptPath;
}

function parseArguments(args) {
  const [releaseDirectory, ...options] = args;
  let platform;
  let manifestPath;
  let receiptPath;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--platform') platform = options[++index];
    else if (option === '--manifest') manifestPath = options[++index];
    else if (option === '--receipt') receiptPath = options[++index];
    else throw new Error(`Unknown option: ${option}`);
  }
  if (
    !releaseDirectory ||
    !platform ||
    !manifestPath ||
    (receiptPath !== undefined && !receiptPath)
  ) {
    throw new Error(
      'Usage: node scripts/commercialization/verify-release-artifact-hashes.mjs <release directory> --platform <platform> --manifest <manifest path> [--receipt <receipt path>]',
    );
  }
  return { releaseDirectory, platform, manifestPath, receiptPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { releaseDirectory, platform, manifestPath, receiptPath } = parseArguments(
      process.argv.slice(2),
    );
    const product = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    );
    const verifiedManifest = verifyReleaseArtifactHashManifest(
      releaseDirectory,
      manifestPath,
      platform,
      product,
    );
    console.log(`Verified release artifact hash manifest: ${resolve(manifestPath)}`);
    if (receiptPath) {
      const writtenPath = writeVerificationReceipt(
        receiptPath,
        releaseDirectory,
        manifestPath,
        verifiedManifest,
      );
      console.log(`Wrote release artifact verification receipt: ${writtenPath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
