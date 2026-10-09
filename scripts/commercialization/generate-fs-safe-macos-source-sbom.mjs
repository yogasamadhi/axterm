import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { nativeReviewScope, nativeReviewScopeSha256 } from './native-dependency-review-ledger.mjs';
import { inventoryPackagedResources } from './packaged-license-inventory.mjs';
import { verifyPackagedArtifactSbomFromInventory } from './verify-packaged-artifact-sbom.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const outputPath = resolve(
  repositoryRoot,
  'compliance/AXTERM_FS_SAFE_MACOS_CARGO_SOURCE.spdx.json',
);
const expectedBinarySha256 = '78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0';
const nativePackageName = '@openclaw/fs-safe-darwin-arm64';
const nativePackageVersion = '0.13.1';
const nativeArtifactSuffix =
  '/app.asar.unpacked/node_modules/@openclaw/fs-safe-darwin-arm64/fs-safe-native.node';
const sourceHeaderBundleSha256 = '52186f73b215d7863766c152499f6bb2caea70187f8e6fe7165a4f6c65a95a8a';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourcePackageId(packageRecord) {
  return `SPDXRef-Cargo-${sha256(`${packageRecord.name}\0${packageRecord.version}`)}`;
}

export function fsSafeMacSourceSbom(inventory, product) {
  if (!product?.name || !product?.version) throw new Error('Product identity is required');
  const packages = nativeReviewScope(inventory).map((component) => ({
    SPDXID: sourcePackageId(component),
    name: component.name,
    versionInfo: component.version,
    primaryPackagePurpose: 'SOURCE',
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    licenseComments: `Pinned Cargo manifest declaration: ${component.license}. No alternative was selected by this inventory.`,
    copyrightText: 'NOASSERTION',
    sourceInfo:
      component.source === 'registry'
        ? 'Registry source package in the pinned macOS normal Cargo graph.'
        : `Project-local source package in ${inventory.source.repository} ${inventory.source.tag} (${inventory.source.commit}).`,
    comment: `Source kind: ${component.source}. Root legal files in the pinned source inventory: ${component.rootLicenseFiles.length ? component.rootLicenseFiles.map(({ name, sha256: hash }) => `${name} (${hash})`).join(', ') : 'none'}. Explicit copyright/SPDX source-header candidates: ${component.sourceHeaderCandidates ? `${component.sourceHeaderCandidates.fileCount} files, ${component.sourceHeaderCandidates.lineCount} lines (${component.sourceHeaderCandidates.sha256})` : 'none found by the bounded pattern sweep'}. See the root, napi/Zstandard and source-header legal supplements; applicability remains unreviewed.`,
    ...(component.source === 'registry'
      ? {
          externalRefs: [
            {
              referenceCategory: 'PACKAGE-MANAGER',
              referenceType: 'purl',
              referenceLocator: `pkg:cargo/${encodeURIComponent(component.name)}@${encodeURIComponent(component.version)}`,
            },
          ],
        }
      : {}),
  }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${product.name} macOS arm64 fs-safe Cargo source-scope inventory`,
    documentNamespace: `https://axterm.dev/sbom/native-source/${encodeURIComponent(product.version)}/macos-arm64/${nativeReviewScopeSha256(inventory)}`,
    creationInfo: {
      created: '2026-09-24T00:00:00Z',
      creators: ['Tool: Axterm fs-safe macOS source-scope SBOM generator'],
      licenseListVersion: '3.23',
      comment: `Pinned source: ${inventory.source.repository} ${inventory.source.tag} (${inventory.source.commit}); Cargo.lock SHA-256 ${inventory.source.cargoLockSha256}.`,
    },
    documentDescribes: packages.map(({ SPDXID }) => SPDXID),
    comment: `Scope: ${packages.length} locked normal-source Cargo package identities for the attested fs-safe v0.13.1 macOS arm64 release source. This is intentionally separate from AXTERM_PRODUCTION_DEPENDENCIES.spdx.json (Bun) and each exact packaged-artifact sidecar. The graph includes build-time/proc-macro packages and does not assert that every package is linked into the published native binary. Manifest licenses and available root texts are leads for qualified review, not selected license options or legal clearance. Expected published macOS binding SHA-256: ${expectedBinarySha256}.`,
    packages,
  };
}

export async function serializeFsSafeMacSourceSbom(sbom) {
  return format(JSON.stringify(sbom), { parser: 'json' });
}

export function fsSafeMacArtifactViolations(packaged, expectedLegalHashes) {
  const violations = [];
  const binaryFiles = packaged.unpackedFiles.filter(({ artifactPath }) =>
    artifactPath.endsWith(nativeArtifactSuffix),
  );
  if (binaryFiles.length !== 1 || binaryFiles[0].sha256 !== expectedBinarySha256)
    violations.push('Packaged fs-safe macOS binding differs from the pinned source-scope target');
  if (
    !packaged.packages.some(
      ({ name, version }) => name === nativePackageName && version === nativePackageVersion,
    )
  ) {
    violations.push('Packaged fs-safe macOS npm identity is missing');
  }
  for (const [name, hash] of Object.entries(expectedLegalHashes)) {
    const entry = packaged.externalLegalFiles.find(({ path }) => path === `licenses/${name}`);
    if (!entry || entry.sha256 !== hash)
      violations.push(`Packaged native legal supplement differs: ${name}`);
  }
  return violations;
}

export async function verifyFsSafeMacSourceArtifact(resourcesDirectory, sidecarPath, inventory) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Native source/artifact comparison is scoped to macOS arm64');
  const product = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const expectedSourceSbom = await serializeFsSafeMacSourceSbom(
    fsSafeMacSourceSbom(inventory, product),
  );
  if (readFileSync(outputPath, 'utf8') !== expectedSourceSbom)
    throw new Error('macOS native source SBOM differs from the pinned Cargo scope');
  const packaged = inventoryPackagedResources(resolve(resourcesDirectory));
  await verifyPackagedArtifactSbomFromInventory(
    packaged,
    product,
    'macos-arm64',
    readFileSync(resolve(sidecarPath), 'utf8'),
  );
  const expectedLegalNames = [
    'fs-safe-rust-ROOT-LICENSES.txt',
    'napi-rs-LICENSE.txt',
    'zstd-sys-Zstandard-LICENSE.txt',
    'zstd-sys-Zstandard-COPYING.txt',
    'fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt',
  ];
  const expectedLegalHashes = Object.fromEntries(
    expectedLegalNames.map((name) => [
      name,
      sha256(readFileSync(resolve(repositoryRoot, 'licenses', name))),
    ]),
  );
  if (expectedLegalHashes['fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt'] !== sourceHeaderBundleSha256)
    throw new Error('Native source-header attribution bundle differs from pinned scope');
  const violations = fsSafeMacArtifactViolations(packaged, expectedLegalHashes);
  if (violations.length) throw new Error(violations.join('; '));
  return {
    sourcePackages: inventory.packageCount,
    sourceSbomSha256: sha256(expectedSourceSbom),
    publishedBindingSha256: expectedBinarySha256,
    packagedAsarSha256: packaged.archiveSha256,
    legalSupplementsCompared: expectedLegalNames.length,
    limitation:
      'This compares a pinned candidate source graph and observed package bytes; the npm attestation is verified separately and exact Rust package linkage/licensing still require qualified review.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const product = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(
      outputPath,
      await serializeFsSafeMacSourceSbom(fsSafeMacSourceSbom(inventory, product)),
    );
    console.log(`Updated ${outputPath} (${inventory.packageCount} pinned Cargo source packages)`);
  } else if (mode === '--check') {
    const expected = await serializeFsSafeMacSourceSbom(fsSafeMacSourceSbom(inventory, product));
    if (readFileSync(outputPath, 'utf8') !== expected) {
      console.error('macOS native source SBOM is stale; run bun run sbom:native:macos:generate');
      process.exitCode = 1;
    } else
      console.log(
        `macOS native source SBOM matches ${inventory.packageCount} pinned Cargo packages.`,
      );
  } else if (mode === '--artifact-check' && process.argv.length === 5) {
    try {
      console.log(
        JSON.stringify(
          await verifyFsSafeMacSourceArtifact(process.argv[3], process.argv[4], inventory),
          null,
          2,
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
    console.error(
      'Usage: generate-fs-safe-macos-source-sbom.mjs --generate|--check|--artifact-check <Resources> <packaged SPDX>',
    );
    process.exitCode = 2;
  }
}
