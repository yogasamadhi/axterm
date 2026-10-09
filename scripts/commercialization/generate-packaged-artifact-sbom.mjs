import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { inventoryPackagedResources } from './packaged-license-inventory.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceDate = '2026-09-21T00:00:00Z';
const sha256 = /^[a-f0-9]{64}$/u;
const platformName = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function stableId(kind, value) {
  return `SPDXRef-${kind}-${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeArtifactPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`Invalid artifact-relative path: ${path}`);
  }
  return path.replaceAll('\\', '/');
}

function validateHash(value, label) {
  if (!sha256.test(value)) throw new Error(`Invalid SHA-256 for ${label}`);
  return value;
}

function npmPurl(name, version) {
  const encodedName = name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function sourcePackage(manifest) {
  if (!manifest.name || !manifest.version) {
    throw new Error(`Packaged manifest lacks identity: ${manifest.manifestPath}`);
  }
  const identity = `${manifest.name}\0${manifest.version}\0${manifest.manifestPath}`;
  return {
    SPDXID: stableId('Package', identity),
    name: manifest.name,
    versionInfo: manifest.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    licenseComments:
      manifest.licenseDeclarations?.length > 0
        ? `Packaged manifest ${manifest.licenseSource} declaration: ${manifest.licenseDeclarations.join(', ')}`
        : 'Packaged manifest does not declare a license.',
    copyrightText: 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPurl(manifest.name, manifest.version),
      },
    ],
    comment: `Observed in ${manifest.manifestPath}; root license files are recorded separately in the package inventory.`,
  };
}

function artifactFile(path, value, comment, fileTypes = ['BINARY']) {
  const artifactPath = normalizeArtifactPath(path);
  return {
    SPDXID: stableId('File', artifactPath),
    fileName: `./${artifactPath}`,
    checksums: [{ algorithm: 'SHA256', checksumValue: validateHash(value, artifactPath) }],
    fileTypes,
    licenseConcluded: 'NOASSERTION',
    licenseInfoInFiles: ['NOASSERTION'],
    copyrightText: 'NOASSERTION',
    comment,
  };
}

function distinctArtifactFiles(entries) {
  const filesByPath = new Map();
  for (const entry of entries) {
    const previous = filesByPath.get(entry.path);
    if (
      previous &&
      (previous.sha256 !== entry.sha256 ||
        JSON.stringify(previous.fileTypes) !== JSON.stringify(entry.fileTypes))
    ) {
      throw new Error(`Conflicting packaged artifact hash for ${entry.path}`);
    }
    if (!previous) filesByPath.set(entry.path, entry);
  }
  return [...filesByPath.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, sha256: value, comment, fileTypes }) =>
      artifactFile(path, value, comment, fileTypes),
    );
}

function rendererAssetFileTypes(path) {
  if (/\.(?:css|html|js|json)$/iu.test(path)) return ['TEXT'];
  if (/\.(?:gif|jpe?g|png|svg|webp)$/iu.test(path)) return ['IMAGE'];
  return ['BINARY'];
}

/**
 * Converts a concrete electron-builder resources inventory into a deterministic
 * SPDX 2.3 sidecar. The sidecar is deliberately generated after packaging: it
 * records an immutable artifact rather than pretending that the source graph
 * proves the contents of a macOS, Windows, or Linux installation.
 */
export function packagedArtifactSbomFromInventory(inventory, product, platform) {
  if (!platformName.test(platform)) throw new Error(`Invalid platform identifier: ${platform}`);
  if (!product?.name || !product?.version) throw new Error('Product name and version are required');

  const archiveHash = validateHash(inventory.archiveSha256, 'app.asar');
  const artifactId = stableId(
    'Package',
    `${product.name}\0${product.version}\0${platform}\0${archiveHash}`,
  );
  const packages = (inventory.packages ?? [])
    .filter(({ name }) => name && !name.startsWith('@workspace/'))
    .map(sourcePackage)
    .sort((left, right) => left.SPDXID.localeCompare(right.SPDXID));
  const files = distinctArtifactFiles([
    {
      path: inventory.archiveArtifactPath,
      sha256: archiveHash,
      comment: 'Electron application ASAR archive.',
      fileTypes: ['ARCHIVE'],
    },
    ...(inventory.rendererAssetFiles ?? []).map(({ path, sha256: value }) => ({
      path: `${inventory.archiveArtifactPath}${path}`,
      sha256: value,
      comment: 'Renderer asset embedded in app.asar.',
      fileTypes: rendererAssetFileTypes(path),
    })),
    ...(inventory.rendererProvenanceFiles ?? []).map(({ path, sha256: value }) => ({
      path: `${inventory.archiveArtifactPath}${path}`,
      sha256: value,
      comment: 'Renderer module-to-chunk provenance embedded in app.asar.',
      fileTypes: ['TEXT'],
    })),
    ...(inventory.unpackedFiles ?? []).map(({ artifactPath, sha256: value }) => ({
      path: artifactPath,
      sha256: value,
      comment: 'File unpacked beside app.asar for runtime loading.',
    })),
    ...(inventory.externalLegalFiles ?? []).map(({ artifactPath, sha256: value }) => ({
      path: artifactPath,
      sha256: value,
      comment: 'Axterm-provided external legal or SPDX material.',
      fileTypes: artifactPath.endsWith('.spdx.json')
        ? ['SPDX', 'TEXT']
        : /\.(?:tar|tgz|zip|gz)$/iu.test(artifactPath)
          ? ['ARCHIVE']
          : ['TEXT'],
    })),
    ...(inventory.electronRuntimeLegalFiles ?? []).map(({ path, sha256: value }) => ({
      path,
      sha256: value,
      comment: 'Electron or Chromium runtime legal material.',
      fileTypes: ['TEXT'],
    })),
  ]);
  const artifactPackage = {
    SPDXID: artifactId,
    name: `${product.name} packaged artifact`,
    versionInfo: product.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    copyrightText: 'NOASSERTION',
    comment: `Observed electron-builder ${platform} artifact with app.asar SHA-256 ${archiveHash}.`,
  };

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${product.name} ${platform} packaged-artifact inventory`,
    documentNamespace: `https://axterm.dev/sbom/artifacts/${encodeURIComponent(product.version)}/${encodeURIComponent(platform)}/${archiveHash}`,
    creationInfo: {
      created: sourceDate,
      creators: ['Tool: Axterm packaged artifact SBOM generator'],
      licenseListVersion: '3.23',
      comment:
        'Deterministic sidecar generated from a concrete electron-builder resources directory.',
    },
    documentDescribes: [artifactId],
    comment:
      'Scope: one concrete packaged artifact. It records observed package manifests plus ASAR, renderer asset/provenance, unpacked-file and legal-material hashes. It is not a complete source-to-binary map, file-level license conclusion, Electron/Chromium component inventory, or legal clearance.',
    packages: [artifactPackage, ...packages],
    files,
    relationships: [
      ...packages.map(({ SPDXID }) => ({
        spdxElementId: artifactId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: SPDXID,
      })),
      ...files.map(({ SPDXID }) => ({
        spdxElementId: artifactId,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: SPDXID,
      })),
    ],
  };
}

export async function serializePackagedArtifactSbom(sbom) {
  return format(JSON.stringify(sbom), { parser: 'json' });
}

function parseArguments(args) {
  const [resourcesDirectory, ...options] = args;
  let platform;
  let output;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--platform') platform = options[++index];
    else if (option === '--output') output = options[++index];
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!resourcesDirectory || !platform || (output !== undefined && !output)) {
    throw new Error(
      'Usage: node scripts/commercialization/generate-packaged-artifact-sbom.mjs <Resources directory> --platform <platform-arch> [--output <sidecar path>]',
    );
  }
  return { resourcesDirectory, platform, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { resourcesDirectory, platform, output } = parseArguments(process.argv.slice(2));
    const product = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    const sbom = await serializePackagedArtifactSbom(
      packagedArtifactSbomFromInventory(
        inventoryPackagedResources(resolve(resourcesDirectory)),
        product,
        platform,
      ),
    );
    if (output) {
      writeFileSync(resolve(output), sbom);
      console.log(`Wrote packaged artifact SPDX sidecar: ${resolve(output)}`);
    } else process.stdout.write(sbom);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
