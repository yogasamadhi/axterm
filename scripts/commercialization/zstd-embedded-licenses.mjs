import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const sourceCommit = '7022a0a10c53e36f34a467df68ed5614a1db1741';
const cargoLockSha256 = 'd169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd';
const crateName = 'zstd-sys';
const crateVersion = '2.1.0+zstd.1.5.7';
const crateSha256 = '0ef0a8027ec3ee71300ab3bcbcd0393f434aa72b91ca6d635a39941deae8eea0';

export const zstdEmbeddedLegalFiles = Object.freeze([
  {
    sourcePath: 'zstd/LICENSE',
    outputName: 'zstd-sys-Zstandard-LICENSE.txt',
    length: 1549,
    sha256: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
  },
  {
    sourcePath: 'zstd/COPYING',
    outputName: 'zstd-sys-Zstandard-COPYING.txt',
    length: 18091,
    sha256: 'f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505',
  },
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function zstdEmbeddedLicenseViolations(inventory, files) {
  const violations = [];
  if (
    inventory.schemaVersion !== 1 ||
    inventory.target !== 'aarch64-apple-darwin' ||
    inventory.source?.commit !== sourceCommit ||
    inventory.source?.cargoLockSha256 !== cargoLockSha256 ||
    !inventory.packages?.some(
      (component) =>
        component.name === crateName &&
        component.version === crateVersion &&
        component.source === 'registry',
    )
  ) {
    violations.push('Pinned macOS Rust source scope differs');
  }
  for (const file of zstdEmbeddedLegalFiles) {
    const bytes = files[file.outputName];
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.length || sha256(bytes) !== file.sha256)
      violations.push(`${file.outputName}: original bytes differ`);
  }
  return violations;
}

function registryDirectory(cargoHome, kind) {
  const parent = join(cargoHome, 'registry', kind);
  const directories = readdirSync(parent).filter((name) => name.startsWith('index.crates.io-'));
  const matches = directories
    .map((directory) => join(parent, directory))
    .filter((directory) =>
      existsSync(
        join(
          directory,
          kind === 'cache' ? `${crateName}-${crateVersion}.crate` : `${crateName}-${crateVersion}`,
        ),
      ),
    );
  if (matches.length !== 1)
    throw new Error(`Expected one ${kind} for ${crateName}@${crateVersion}`);
  return matches[0];
}

function pinnedSourceFiles(inventory, upstreamRoot, cargoHome) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: upstreamRoot,
    encoding: 'utf8',
  }).trim();
  if (commit !== sourceCommit || inventory.source.commit !== commit)
    throw new Error(`Unexpected fs-safe source commit: ${commit}`);
  const lock = readFileSync(join(upstreamRoot, 'Cargo.lock'));
  if (sha256(lock) !== cargoLockSha256)
    throw new Error('fs-safe Cargo.lock differs from pinned source inventory');
  if (
    !lock
      .toString('utf8')
      .includes(
        `name = "${crateName}"\nversion = "${crateVersion}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${crateSha256}"`,
      )
  ) {
    throw new Error('zstd-sys Cargo.lock identity/checksum differs');
  }

  const archive = join(registryDirectory(cargoHome, 'cache'), `${crateName}-${crateVersion}.crate`);
  if (sha256(readFileSync(archive)) !== crateSha256)
    throw new Error('zstd-sys .crate archive checksum differs from Cargo.lock');
  const sourceRoot = join(registryDirectory(cargoHome, 'src'), `${crateName}-${crateVersion}`);
  const files = {};
  for (const file of zstdEmbeddedLegalFiles) {
    const archived = execFileSync('tar', [
      '-xOzf',
      archive,
      `${crateName}-${crateVersion}/${file.sourcePath}`,
    ]);
    const extracted = readFileSync(join(sourceRoot, file.sourcePath));
    if (!archived.equals(extracted))
      throw new Error(`${file.sourcePath}: Cargo cache source differs from checked archive`);
    files[file.outputName] = archived;
  }
  const violations = zstdEmbeddedLicenseViolations(inventory, files);
  if (violations.length) throw new Error(violations.join('; '));
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--generate') {
    const sourceRoot = process.argv[3];
    if (!sourceRoot) throw new Error('Usage: --generate <fs-safe v0.13.1 source checkout>');
    const files = pinnedSourceFiles(
      inventory,
      resolve(sourceRoot),
      process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    );
    for (const [name, bytes] of Object.entries(files))
      writeFileSync(join(repositoryRoot, 'licenses', name), bytes);
    console.log(
      'Updated two pinned Zstandard embedded legal texts from the checked Cargo archive.',
    );
  } else if (mode === '--check') {
    const files = Object.fromEntries(
      zstdEmbeddedLegalFiles.map((file) => [
        file.outputName,
        readFileSync(join(repositoryRoot, 'licenses', file.outputName)),
      ]),
    );
    const violations = zstdEmbeddedLicenseViolations(inventory, files);
    if (violations.length) {
      for (const violation of violations) console.error(`- ${violation}`);
      process.exitCode = 1;
    } else {
      console.log('Two Zstandard embedded legal texts match the pinned macOS Cargo archive.');
    }
  } else {
    console.error('Usage: zstd-embedded-licenses.mjs --generate <source checkout>|--check');
    process.exitCode = 2;
  }
}
