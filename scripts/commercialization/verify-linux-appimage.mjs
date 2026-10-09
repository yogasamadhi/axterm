import { spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryPackagedResources } from './packaged-license-inventory.mjs';
import { verifyPackagedArtifactSbomFromInventory } from './verify-packaged-artifact-sbom.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const squashfsMagic = Buffer.from('hsqs');
const maximumHeaderBytes = 16 * 1024 * 1024;
const requiredLegalEntries = [
  'LICENSE.axterm',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
  'THIRD_PARTY_COMPONENTS.json',
  'THIRD_PARTY_LICENSE_TEXTS.json',
  'THIRD_PARTY_NOTICES.txt',
  'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
  'licenses',
];

/** Locate the embedded SquashFS superblock without executing the AppImage runtime. */
export function findSquashfsOffset(header, artifactBytes) {
  const matches = [];
  for (
    let offset = header.indexOf(squashfsMagic);
    offset >= 0;
    offset = header.indexOf(squashfsMagic, offset + 1)
  ) {
    if (offset + 96 > header.length) continue;
    const blockBytes = header.readUInt32LE(offset + 12);
    const filesystemBytes = header.readBigUInt64LE(offset + 40);
    if (
      header.readUInt16LE(offset + 28) !== 4 ||
      header.readUInt16LE(offset + 30) !== 0 ||
      blockBytes < 4096 ||
      blockBytes > 1048576 ||
      (blockBytes & (blockBytes - 1)) !== 0 ||
      filesystemBytes < 96n ||
      BigInt(offset) + filesystemBytes > BigInt(artifactBytes)
    ) {
      continue;
    }
    matches.push(offset);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one valid embedded SquashFS superblock; found ${matches.length}`);
  }
  return matches[0];
}

function parseArguments(args) {
  let artifactDirectory = 'release';
  let sidecarPath;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (seen.has(option)) throw new Error(`Repeated option: ${option}`);
    if (option === '--artifact-dir' || option === '--sidecar') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
      if (option === '--artifact-dir') artifactDirectory = value;
      else sidecarPath = value;
      seen.add(option);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  const directory = resolve(artifactDirectory);
  return {
    directory,
    sidecarPath: resolve(
      sidecarPath ?? join(directory, 'AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json'),
    ),
  };
}

function embeddedFilesystemOffset(path, bytes) {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(Math.min(bytes, maximumHeaderBytes));
    const readBytes = readSync(descriptor, header, 0, header.length, 0);
    return findSquashfsOffset(header.subarray(0, readBytes), bytes);
  } finally {
    closeSync(descriptor);
  }
}

function checkRequiredLegalEntries(extractedRoot) {
  for (const entry of requiredLegalEntries) {
    const path = join(extractedRoot, entry);
    const details = lstatSync(path);
    if (entry === 'licenses' ? !details.isDirectory() : !details.isFile()) {
      throw new Error(`AppImage legal entry has the wrong type: ${entry}`);
    }
  }
  if (readdirSync(join(extractedRoot, 'licenses')).length === 0) {
    throw new Error('AppImage licenses directory is empty');
  }
}

export async function verifyLinuxAppImage(artifactDirectory, sidecarPath) {
  const appImages = readdirSync(artifactDirectory).filter((name) => name.endsWith('.AppImage'));
  if (appImages.length !== 1) {
    throw new Error(
      `Expected exactly one Linux AppImage in ${artifactDirectory}; found ${appImages.length}`,
    );
  }
  const appImagePath = join(artifactDirectory, appImages[0]);
  const details = lstatSync(appImagePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error('Linux AppImage must be a regular file, not a symbolic link');
  }
  const offset = embeddedFilesystemOffset(appImagePath, details.size);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'axterm-appimage-audit-'));
  try {
    const extractedRoot = join(temporaryRoot, 'extracted');
    const extraction = spawnSync(
      'unsquashfs',
      ['-q', '-o', String(offset), '-d', extractedRoot, appImagePath],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
    );
    if (extraction.error || extraction.status !== 0) {
      throw new Error(
        `Failed to extract Linux AppImage with unsquashfs: ${extraction.error?.message ?? extraction.stderr?.trim() ?? `exit ${extraction.status}`}`,
      );
    }
    checkRequiredLegalEntries(extractedRoot);
    const product = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
    const result = await verifyPackagedArtifactSbomFromInventory(
      inventoryPackagedResources(join(extractedRoot, 'resources')),
      product,
      'linux-x64',
      readFileSync(sidecarPath, 'utf8'),
    );
    return { appImage: basename(appImagePath), offset, bytes: details.size, ...result };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { directory, sidecarPath } = parseArguments(process.argv.slice(2));
    const result = await verifyLinuxAppImage(directory, sidecarPath);
    console.log(
      `Verified Linux AppImage ${result.appImage} (${result.bytes} bytes, SquashFS offset ${result.offset}): SPDX ${result.sidecarSha256}, app.asar ${result.archiveSha256}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
