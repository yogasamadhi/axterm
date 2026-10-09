import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platformExtensions = {
  'macos-arm64': new Set(['.dmg', '.zip']),
  'windows-x64': new Set(['.exe']),
  'linux-x64': new Set(['.AppImage', '.deb']),
};

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isProductArtifact(name) {
  return /^axterm(?:[-_. ]|$)/iu.test(name);
}

function extension(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index);
}

/**
 * Creates a deterministic, platform-scoped manifest for the distributable
 * files that electron-builder produced. It deliberately excludes sidecars and
 * unpacked directories: those are covered by the packaged SPDX inventory.
 */
export function releaseArtifactHashManifest(releaseDirectory, platform, product) {
  const expectedExtensions = platformExtensions[platform];
  if (!expectedExtensions) throw new Error(`Unsupported release platform: ${platform}`);
  if (!product?.name || !product?.version) throw new Error('Product name and version are required');

  const root = resolve(releaseDirectory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Release directory does not exist: ${root}`);
  }
  const artifacts = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isProductArtifact(entry.name))
    .filter((entry) => expectedExtensions.has(extension(entry.name)))
    .map((entry) => {
      const path = resolve(root, entry.name);
      return {
        path: relative(root, path).replaceAll('\\', '/'),
        bytes: statSync(path).size,
        sha256: sha256(path),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  if (artifacts.length === 0) {
    throw new Error(
      `No ${platform} Axterm artifacts found in ${root}; expected ${[...expectedExtensions].join(', ')}`,
    );
  }
  return {
    schemaVersion: 1,
    product: { name: product.name, version: product.version },
    platform,
    artifacts,
    limitations: [
      'This records bytes emitted by one unsigned electron-builder run; it is not a signing, notarization, installation, upgrade, source-rights or release approval.',
      'The corresponding packaged SPDX sidecar inventories app resources; this manifest hashes distributable installer/archive files only.',
    ],
  };
}

function parseArguments(args) {
  const [releaseDirectory, ...options] = args;
  let platform;
  let output;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--platform') platform = options[++index];
    else if (option === '--output') output = options[++index];
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!releaseDirectory || !platform || (output !== undefined && !output)) {
    throw new Error(
      'Usage: node scripts/commercialization/generate-release-artifact-hashes.mjs <release directory> --platform <platform> [--output <manifest>]',
    );
  }
  return { releaseDirectory, platform, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { releaseDirectory, platform, output } = parseArguments(process.argv.slice(2));
    const product = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    );
    const manifest = `${JSON.stringify(
      releaseArtifactHashManifest(releaseDirectory, platform, product),
      null,
      2,
    )}\n`;
    if (output) {
      const path = resolve(output);
      writeFileSync(path, manifest);
      console.log(`Wrote release artifact hash manifest: ${path}`);
    } else process.stdout.write(manifest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
