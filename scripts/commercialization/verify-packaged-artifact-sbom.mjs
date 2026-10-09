import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  packagedArtifactSbomFromInventory,
  serializePackagedArtifactSbom,
} from './generate-packaged-artifact-sbom.mjs';
import { inventoryPackagedResources } from './packaged-license-inventory.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Verify that a retained sidecar still describes the exact packaged resources. */
export async function verifyPackagedArtifactSbomFromInventory(
  inventory,
  product,
  platform,
  sidecar,
) {
  const expected = await serializePackagedArtifactSbom(
    packagedArtifactSbomFromInventory(inventory, product, platform),
  );
  if (sidecar !== expected) {
    throw new Error(
      `Packaged SPDX sidecar does not match ${platform} app resources: expected SHA-256 ${sha256(expected)}, observed ${sha256(sidecar)}`,
    );
  }
  return { sidecarSha256: sha256(expected), archiveSha256: inventory.archiveSha256 };
}

export function packagedArtifactVerificationReceipt(
  sidecarPath,
  sidecar,
  result,
  product,
  platform,
) {
  return {
    schemaVersion: 1,
    verification: 'packaged-spdx-byte-verification',
    product: { name: product.name, version: product.version },
    platform,
    sidecar: {
      path: basename(sidecarPath),
      bytes: Buffer.byteLength(sidecar),
      sha256: result.sidecarSha256,
    },
    appAsarSha256: result.archiveSha256,
    limitations: [
      'This receipt records that the named sidecar matched the selected local packaged Resources when the verifier ran.',
      'Workflow placement determines whether the sidecar came from an artifact download; this receipt alone does not prove its transport origin.',
      'The SPDX inventory covers selected packaged resources, not every binary or a source-to-binary rights conclusion.',
    ],
  };
}

function writeVerificationReceipt(receiptPath, resourcesDirectory, sidecarPath, receipt) {
  const path = resolve(receiptPath);
  const withinResources = relative(resolve(resourcesDirectory), path);
  if (
    path === resolve(sidecarPath) ||
    withinResources === '' ||
    (withinResources !== '..' &&
      !withinResources.startsWith(`..${sep}`) &&
      !isAbsolute(withinResources))
  ) {
    throw new Error('SPDX verification receipt must not overwrite the sidecar or app resources');
  }
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return path;
}

function parseArguments(args) {
  const [resourcesDirectory, ...options] = args;
  let platform;
  let sidecarPath;
  let receiptPath;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === '--platform' && platform === undefined) platform = options[++index];
    else if (option === '--sidecar' && sidecarPath === undefined) sidecarPath = options[++index];
    else if (option === '--receipt' && receiptPath === undefined) receiptPath = options[++index];
    else throw new Error(`Unknown or repeated option: ${option}`);
  }
  if (
    !resourcesDirectory ||
    !platform ||
    !sidecarPath ||
    (receiptPath !== undefined && !receiptPath)
  ) {
    throw new Error(
      'Usage: node scripts/commercialization/verify-packaged-artifact-sbom.mjs <Resources directory> --platform <platform-arch> --sidecar <SPDX sidecar> [--receipt <new receipt path>]',
    );
  }
  return { resourcesDirectory, platform, sidecarPath, receiptPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { resourcesDirectory, platform, sidecarPath, receiptPath } = parseArguments(
      process.argv.slice(2),
    );
    const product = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    );
    const sidecar = readFileSync(resolve(sidecarPath), 'utf8');
    const result = await verifyPackagedArtifactSbomFromInventory(
      inventoryPackagedResources(resolve(resourcesDirectory)),
      product,
      platform,
      sidecar,
    );
    console.log(
      `Verified packaged SPDX sidecar for ${platform}: ${result.sidecarSha256} (app.asar ${result.archiveSha256})`,
    );
    if (receiptPath) {
      const receipt = packagedArtifactVerificationReceipt(
        sidecarPath,
        sidecar,
        result,
        product,
        platform,
      );
      console.log(
        `Wrote packaged SPDX verification receipt: ${writeVerificationReceipt(receiptPath, resourcesDirectory, sidecarPath, receipt)}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
