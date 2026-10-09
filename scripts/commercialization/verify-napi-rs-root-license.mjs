import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const licensePath = resolve(repositoryRoot, 'licenses/napi-rs-LICENSE.txt');
const rootLicenseSha256 = '3f1ce66533302df3a32edbfdfc0b78f0dd34659e4c1f5817162e5ea3c2297215';
const fsSafeCargoLockSha256 = 'd169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd';
const upstreamRepository = 'https://github.com/napi-rs/napi-rs';

export const napiCrateSources = Object.freeze([
  {
    name: 'napi',
    version: '3.12.2',
    crateSha256: '58c5f4d5375213fdb7be2655e152386e82f026f9a5ba36a75556e11359aafe09',
    vcsCommit: '444bf29b8534216dd1cec4695a71e5996a173e87',
    pathInVcs: 'crates/napi',
    vcsInfoSha256: 'baabdba3788af44db78b35c00d15ea9a24610dfd0e52470bed76e5c5ba5583b4',
  },
  {
    name: 'napi-derive',
    version: '3.6.3',
    crateSha256: '0fa55ea69990c90b888e9e77044410e304ce7f35de599dc6d0b5c1923d2e59af',
    vcsCommit: '956e4525fea6a676ea3680b711382f167b899af9',
    pathInVcs: 'crates/macro',
    vcsInfoSha256: '2c9bc5f2915254c67bf885d7f195eff8d2a6c9a3a2d158eccca9f75af7f6a93f',
  },
  {
    name: 'napi-derive-backend',
    version: '6.1.2',
    crateSha256: 'df4056ac7c18e4438ccf0edaed4340ca0d269278c8ec19284f7b23cb039fd0ae',
    vcsCommit: '956e4525fea6a676ea3680b711382f167b899af9',
    pathInVcs: 'crates/backend',
    vcsInfoSha256: '46623c4bfa253fca6b668a4e6b3cdcbe04826bf20912b75b9aeb3e92761a0c2d',
  },
  {
    name: 'napi-sys',
    version: '3.3.0',
    crateSha256: '85fbf1fa9f1babfe396d74bbbf52b3643770243e8f5b0b46715d4caf7f0dfc9a',
    vcsCommit: '679eb79f5cf3c7c6b2850f4ab46092126f23dc5c',
    pathInVcs: 'crates/sys',
    vcsInfoSha256: '8516ccb161428a6b2bbc1865cf5588f6974b921ea10c1689c15b5eb75649a7a3',
  },
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identity(component) {
  return `${component.name}@${component.version}`;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right, 'en'));
}

export function napiRootLicenseViolations(inventory, licenseBytes) {
  const violations = [];
  if (
    inventory.schemaVersion !== 1 ||
    inventory.target !== 'aarch64-apple-darwin' ||
    inventory.source?.repository !== 'https://github.com/openclaw/fs-safe' ||
    inventory.source?.cargoLockSha256 !== fsSafeCargoLockSha256
  ) {
    violations.push('fs-safe native source inventory differs');
  }
  const missingRegistryRoots = inventory.packages
    .filter(
      (component) => component.source === 'registry' && component.rootLicenseFiles.length === 0,
    )
    .map(identity);
  if (
    JSON.stringify(sorted(missingRegistryRoots)) !==
    JSON.stringify(sorted(napiCrateSources.map(identity)))
  )
    violations.push('Registry packages without root legal files differ from the pinned napi scope');
  for (const expected of napiCrateSources) {
    const component = inventory.packages.find(
      (entry) => entry.name === expected.name && entry.version === expected.version,
    );
    if (
      !component ||
      component.license !== 'MIT' ||
      component.source !== 'registry' ||
      component.rootLicenseFiles.length !== 0
    ) {
      violations.push(`${identity(expected)}: Cargo inventory declaration differs`);
    }
  }
  if (licenseBytes.length !== 2138 || sha256(licenseBytes) !== rootLicenseSha256)
    violations.push('napi-rs upstream root LICENSE bytes differ');
  return violations;
}

function walkRegularFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkRegularFiles(root, path);
    if (!entry.isFile() || !statSync(path).isFile())
      throw new Error(`Unexpected non-file in Cargo source: ${path}`);
    return [relative(root, path).replaceAll('\\', '/')];
  });
}

function upstreamBytes(upstreamRoot, commit, sourcePath) {
  return execFileSync('git', ['show', `${commit}:${sourcePath}`], {
    cwd: upstreamRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function cargoPackageChecksum(lock, component) {
  const stanzas = lock.split(/^\[\[package\]\]\s*$/mu);
  const stanza = stanzas.find(
    (entry) =>
      entry.includes(`name = "${component.name}"\n`) &&
      entry.includes(`version = "${component.version}"\n`),
  );
  const checksum = stanza && /^checksum = "([a-f0-9]{64})"$/mu.exec(stanza)?.[1];
  if (checksum !== component.crateSha256)
    throw new Error(`${identity(component)}: Cargo.lock checksum differs`);
}

export function verifyNapiPublishedSources(inventory, upstreamRoot, fsSafeRoot, cargoHome) {
  const violations = napiRootLicenseViolations(inventory, readFileSync(licensePath));
  if (violations.length) throw new Error(violations.join('; '));
  const lockBytes = readFileSync(join(fsSafeRoot, 'Cargo.lock'));
  if (sha256(lockBytes) !== fsSafeCargoLockSha256)
    throw new Error('fs-safe Cargo.lock is not the pinned native build input');
  const lock = lockBytes.toString('utf8');
  const registryRoot = join(cargoHome, 'registry');
  let matchedSourceFiles = 0;
  for (const component of napiCrateSources) {
    cargoPackageChecksum(lock, component);
    const sourceNames = readdirSync(join(registryRoot, 'src')).filter((name) =>
      name.startsWith('index.crates.io-'),
    );
    const sourcePaths = sourceNames
      .map((name) => join(registryRoot, 'src', name, `${component.name}-${component.version}`))
      .filter(existsSync);
    const archivePaths = sourceNames
      .map((name) =>
        join(registryRoot, 'cache', name, `${component.name}-${component.version}.crate`),
      )
      .filter(existsSync);
    if (sourcePaths.length !== 1 || archivePaths.length !== 1)
      throw new Error(`${identity(component)}: expected one local Cargo source/archive pair`);
    const sourceRoot = sourcePaths[0];
    const archivePath = archivePaths[0];
    if (!sourceRoot || !archivePath || sha256(readFileSync(archivePath)) !== component.crateSha256)
      throw new Error(`${identity(component)}: published .crate archive differs`);
    const vcsBytes = readFileSync(join(sourceRoot, '.cargo_vcs_info.json'));
    const vcs = JSON.parse(vcsBytes.toString('utf8'));
    if (
      sha256(vcsBytes) !== component.vcsInfoSha256 ||
      vcs.git?.sha1 !== component.vcsCommit ||
      vcs.path_in_vcs !== component.pathInVcs
    ) {
      throw new Error(`${identity(component)}: Cargo VCS metadata differs`);
    }
    const manifest = readFileSync(join(sourceRoot, 'Cargo.toml'), 'utf8');
    if (
      !manifest.includes('license = "MIT"') ||
      !manifest.includes(`repository = "${upstreamRepository}"`)
    )
      throw new Error(`${identity(component)}: package manifest declaration differs`);
    const rootLicense = upstreamBytes(upstreamRoot, component.vcsCommit, 'LICENSE');
    if (!rootLicense.equals(readFileSync(licensePath)))
      throw new Error(`${identity(component)}: pinned upstream root LICENSE differs`);
    const originalManifest = readFileSync(join(sourceRoot, 'Cargo.toml.orig'));
    const upstreamManifest = upstreamBytes(
      upstreamRoot,
      component.vcsCommit,
      `${component.pathInVcs}/Cargo.toml`,
    );
    if (!originalManifest.equals(upstreamManifest))
      throw new Error(`${identity(component)}: original Cargo manifest differs from upstream`);
    const files = walkRegularFiles(sourceRoot).filter(
      (path) =>
        ![
          '.cargo-ok',
          '.cargo_vcs_info.json',
          'Cargo.lock',
          'Cargo.toml',
          'Cargo.toml.orig',
        ].includes(path),
    );
    for (const path of files) {
      const packaged = readFileSync(join(sourceRoot, path));
      const upstream = upstreamBytes(
        upstreamRoot,
        component.vcsCommit,
        `${component.pathInVcs}/${path}`,
      );
      if (!packaged.equals(upstream))
        throw new Error(`${identity(component)}/${path}: published source differs from upstream`);
      matchedSourceFiles += 1;
    }
  }
  return {
    packages: napiCrateSources.length,
    matchedSourceFiles,
    licenseSha256: rootLicenseSha256,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--check') {
    const violations = napiRootLicenseViolations(inventory, readFileSync(licensePath));
    if (violations.length) {
      for (const violation of violations) console.error(`- ${violation}`);
      process.exitCode = 1;
    } else console.log('Pinned napi-rs root LICENSE covers four missing-root Cargo declarations.');
  } else if (mode === '--source-check') {
    const upstreamRoot = process.argv[3];
    const fsSafeRoot = process.argv[4];
    if (!upstreamRoot || !fsSafeRoot)
      throw new Error('Usage: --source-check <napi-rs Git repository> <fs-safe v0.13.1 source>');
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
    console.log(
      JSON.stringify(
        verifyNapiPublishedSources(
          inventory,
          resolve(upstreamRoot),
          resolve(fsSafeRoot),
          cargoHome,
        ),
      ),
    );
  } else {
    console.error(
      'Usage: verify-napi-rs-root-license.mjs --check|--source-check <napi-rs Git repository> <fs-safe v0.13.1 source>',
    );
    process.exitCode = 2;
  }
}
