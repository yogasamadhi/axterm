import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryViolations } from './ironrdp-wasm-source-scope.mjs';

const root = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
);
const legalPath = resolve(root, 'licenses/tracing-core-spin-LICENSE.txt');
const sourceCommit = 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6';

export const tracingCoreSpinLicense = Object.freeze({
  name: 'tracing-core',
  version: '0.1.36',
  sourcePath: 'src/spin/LICENSE',
  packagedPath: 'licenses/tracing-core-spin-LICENSE.txt',
  archiveSha256: 'db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a',
  sha256: '58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, maxBuffer: 100 * 1024 * 1024 });
}

export function ironRdpNestedLicenseViolations(inventory, legalBytes) {
  const violations = inventoryViolations(inventory);
  const candidate = inventory.packages.find(
    ({ name, version }) =>
      name === tracingCoreSpinLicense.name && version === tracingCoreSpinLicense.version,
  );
  if (
    candidate?.source !== 'registry' ||
    candidate.checksum !== tracingCoreSpinLicense.archiveSha256 ||
    candidate.license !== 'MIT'
  ) {
    violations.push('Pinned tracing-core crate identity or declaration differs');
  }
  if (sha256(legalBytes) !== tracingCoreSpinLicense.sha256)
    violations.push('tracing-core nested spin license bytes differ');
  return violations;
}

function registryArchive(cargoHome, entry) {
  const parent = join(cargoHome, 'registry', 'cache');
  const archives = readdirSync(parent)
    .filter((name) => name.startsWith('index.crates.io-'))
    .map((name) => join(parent, name, `${entry.name}-${entry.version}.crate`))
    .filter(existsSync);
  if (archives.length !== 1)
    throw new Error(`Expected one cached published archive: ${entry.name}@${entry.version}`);
  const archive = archives[0];
  if (sha256(readFileSync(archive)) !== entry.checksum)
    throw new Error(`Locked crate archive bytes differ: ${entry.name}@${entry.version}`);
  return archive;
}

// This is a legal *filename* sweep, not a copyright-header or file-level rights review.
function legalFilename(name) {
  return (
    /^(?:LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT|AUTHORS)(?:[._-].*)?$/iu.test(name) &&
    !/\.(?:rs|c|cc|cpp|h|js|jsx|ts|tsx)$/iu.test(name)
  );
}

function nestedWorkspacePaths(directory) {
  const found = [];
  function visit(parent, relativePath = '') {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(parent, entry.name), childPath);
      else if (entry.isFile() && relativePath && legalFilename(entry.name)) found.push(childPath);
      else if (entry.isSymbolicLink() && !relativePath) {
        // Workspace crate-root license links are already preserved by the root-text inventory.
        continue;
      } else if (entry.isSymbolicLink())
        throw new Error(`Unexpected linked workspace source: ${directory}/${childPath}`);
    }
  }
  visit(directory);
  return found;
}

export function nestedLegalPathsFromArchiveListing(listing, entry) {
  const prefix = `${entry.name}-${entry.version}/`;
  return listing
    .trim()
    .split('\n')
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter((path) => path.includes('/') && legalFilename(basename(path)));
}

export function inspectIronRdpNestedLegalSources(inventory, checkout, cargoHome) {
  const violations = ironRdpNestedLicenseViolations(inventory, readFileSync(legalPath));
  if (violations.length) throw new Error(violations.join('; '));
  const upstream = resolve(checkout);
  if (command('git', ['rev-parse', 'HEAD'], upstream).toString().trim() !== sourceCommit)
    throw new Error('IronRDP source checkout is not the pinned commit');
  if (command('git', ['status', '--porcelain', '--untracked-files=no'], upstream).toString().trim())
    throw new Error('IronRDP source checkout has changed tracked files');
  const found = [];
  for (const entry of inventory.packages) {
    const paths =
      entry.source === 'registry'
        ? nestedLegalPathsFromArchiveListing(
            command('tar', ['-tzf', registryArchive(cargoHome, entry)], root).toString('utf8'),
            entry,
          )
        : nestedWorkspacePaths(join(upstream, entry.path));
    found.push(...paths.map((path) => `${entry.name}@${entry.version} ${path}`));
  }
  found.sort();
  const expected = `${tracingCoreSpinLicense.name}@${tracingCoreSpinLicense.version} ${tracingCoreSpinLicense.sourcePath}`;
  if (found.length !== 1 || found[0] !== expected)
    throw new Error(`IronRDP nested legal filename scope changed: ${found.join(', ')}`);
  const tracingCore = inventory.packages.find(
    ({ name, version }) =>
      name === tracingCoreSpinLicense.name && version === tracingCoreSpinLicense.version,
  );
  const archive = registryArchive(cargoHome, tracingCore);
  const archived = command(
    'tar',
    [
      '-xOf',
      archive,
      `${tracingCoreSpinLicense.name}-${tracingCoreSpinLicense.version}/${tracingCoreSpinLicense.sourcePath}`,
    ],
    root,
  );
  if (!archived.equals(readFileSync(legalPath)))
    throw new Error('Preserved tracing-core spin license differs from locked crate archive');
  return { sourcePackages: inventory.packages.length, nestedLegalFiles: found };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--check') {
    const violations = ironRdpNestedLicenseViolations(inventory, readFileSync(legalPath));
    if (violations.length) throw new Error(violations.join('; '));
    console.log('Pinned tracing-core spin license matches the preserved nested text.');
  } else if (mode === '--source-check' && process.argv.length === 4) {
    console.log(
      JSON.stringify(
        inspectIronRdpNestedLegalSources(
          inventory,
          process.argv[3],
          process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
        ),
        null,
        2,
      ),
    );
  } else throw new Error('Usage: ironrdp-nested-license.mjs --check|--source-check <checkout>');
}
