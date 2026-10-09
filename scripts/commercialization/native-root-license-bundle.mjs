import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  repositoryRoot,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const outputPath = resolve(repositoryRoot, 'licenses/fs-safe-rust-ROOT-LICENSES.txt');
const parentLicenseSha256 = '8d703995c48aeb3726ab83f111a10ee696835e096802ee0329ac50216ab9434e';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function entriesFromInventory(inventory) {
  if (
    inventory.schemaVersion !== 1 ||
    inventory.target !== 'aarch64-apple-darwin' ||
    inventory.source?.commit !== '7022a0a10c53e36f34a467df68ed5614a1db1741' ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== inventory.packageCount
  ) {
    throw new Error('Native root-license inventory has changed');
  }
  const entries = [
    {
      identity: '@openclaw/fs-safe@0.13.1 (tagged source root)',
      name: 'LICENSE',
      sha256: parentLicenseSha256,
      source: 'tag-source',
    },
  ];
  for (const component of inventory.packages) {
    if (!['registry', 'tag-source'].includes(component.source))
      throw new Error(`Unsupported native source: ${component.name}`);
    for (const file of component.rootLicenseFiles) {
      if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid legal-file hash');
      entries.push({
        identity: `${component.name}@${component.version}`,
        name: file.name,
        sha256: file.sha256,
        source: component.source,
      });
    }
  }
  return entries;
}

function introduction(inventory, entries) {
  return Buffer.from(
    [
      'Axterm supplementary fs-safe native Rust root legal texts',
      '',
      `Source: ${inventory.source.repository} ${inventory.source.tag} (${inventory.source.commit})`,
      `Target/source graph: ${inventory.target}; ${inventory.packageCount} Cargo package identities; ${entries.length} preserved root files.`,
      'The original file bytes appear between each BEGIN/END marker. Lengths and SHA-256 values are checked against the pinned source inventory.',
      'This is a conservative source-graph collection, not a declaration that every alternative license is used or that all texts cover the exact published binary.',
      'Four napi-family source crates have no own root legal file; nested/inlined notices, copyright, source-to-binary and other-platform review remain open.',
      '',
    ].join('\n') + '\n',
    'utf8',
  );
}

function beginMarker(entry, length) {
  return Buffer.from(
    `===== BEGIN ${entry.identity} / ${entry.name} | ${length} bytes | SHA-256 ${entry.sha256} =====\n`,
    'utf8',
  );
}

function endMarker(entry) {
  return Buffer.from(`\n===== END ${entry.identity} / ${entry.name} =====\n\n`, 'utf8');
}

function registrySourcePath(cargoHome, component) {
  const registryRoot = join(cargoHome, 'registry/src');
  const candidates = readdirSync(registryRoot)
    .filter((directory) => directory.startsWith('index.crates.io-'))
    .map((directory) => join(registryRoot, directory, `${component.name}-${component.version}`))
    .filter(existsSync);
  if (candidates.length !== 1)
    throw new Error(`Expected one registry source for ${component.name}@${component.version}`);
  return candidates[0];
}

function sourceFiles(inventory, upstreamRoot, cargoHome) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: upstreamRoot,
    encoding: 'utf8',
  }).trim();
  if (commit !== inventory.source.commit)
    throw new Error(`Unexpected fs-safe source commit: ${commit}`);
  const entries = entriesFromInventory(inventory);
  const files = [{ entry: entries[0], bytes: readFileSync(join(upstreamRoot, 'LICENSE')) }];
  for (const component of inventory.packages) {
    const packageRoot =
      component.source === 'registry'
        ? registrySourcePath(cargoHome, component)
        : join(upstreamRoot, component.name === 'fs-safe-native' ? 'native' : 'archive-core');
    for (const file of component.rootLicenseFiles) {
      files.push({
        entry: {
          identity: `${component.name}@${component.version}`,
          name: file.name,
          sha256: file.sha256,
        },
        bytes: readFileSync(join(packageRoot, file.name)),
      });
    }
  }
  for (const { entry, bytes } of files) {
    if (sha256(bytes) !== entry.sha256)
      throw new Error(`Source legal-file hash differs: ${entry.identity}/${entry.name}`);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      throw new Error(`Source legal file is not UTF-8: ${entry.identity}/${entry.name}`);
  }
  return files;
}

export function nativeRootLicenseBundle(inventory, files) {
  const entries = entriesFromInventory(inventory);
  if (
    files.length !== entries.length ||
    files.some(({ entry }, index) =>
      ['identity', 'name', 'sha256'].some((key) => entry[key] !== entries[index][key]),
    )
  ) {
    throw new Error('Native legal files do not match inventory order');
  }
  return Buffer.concat([
    introduction(inventory, entries),
    ...files.flatMap(({ entry, bytes }) => [
      beginMarker(entry, bytes.length),
      bytes,
      endMarker(entry),
    ]),
  ]);
}

export function nativeRootLicenseBundleViolations(inventory, bundle) {
  const entries = entriesFromInventory(inventory);
  const violations = [];
  const preface = introduction(inventory, entries);
  if (!bundle.subarray(0, preface.length).equals(preface))
    return ['Native root-license bundle introduction differs'];
  let offset = preface.length;
  for (const entry of entries) {
    const lineEnd = bundle.indexOf(10, offset);
    if (lineEnd === -1) return [`${entry.identity}/${entry.name}: missing BEGIN marker`];
    const line = bundle.toString('utf8', offset, lineEnd);
    const match = /^===== BEGIN (.+) \/ (.+) \| (\d+) bytes \| SHA-256 ([a-f0-9]{64}) =====$/u.exec(
      line,
    );
    if (
      !match ||
      match[1] !== entry.identity ||
      match[2] !== entry.name ||
      match[4] !== entry.sha256
    ) {
      return [`${entry.identity}/${entry.name}: BEGIN marker differs`];
    }
    const length = Number(match[3]);
    if (!Number.isSafeInteger(length) || length < 0)
      return [`${entry.identity}/${entry.name}: invalid byte length`];
    offset = lineEnd + 1;
    const bytes = bundle.subarray(offset, offset + length);
    if (bytes.length !== length || sha256(bytes) !== entry.sha256)
      violations.push(`${entry.identity}/${entry.name}: original bytes differ`);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      violations.push(`${entry.identity}/${entry.name}: text is not UTF-8`);
    offset += length;
    const end = endMarker(entry);
    if (!bundle.subarray(offset, offset + end.length).equals(end))
      return [...violations, `${entry.identity}/${entry.name}: END marker differs`];
    offset += end.length;
  }
  if (offset !== bundle.length) violations.push('Unexpected trailing native legal material');
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const mode = process.argv[2];
  if (mode === '--generate') {
    const upstreamRoot = process.argv[3];
    if (!upstreamRoot) throw new Error('Usage: --generate <fs-safe v0.13.1 source checkout>');
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
    const files = sourceFiles(inventory, resolve(upstreamRoot), cargoHome);
    const bundle = nativeRootLicenseBundle(inventory, files);
    writeFileSync(outputPath, bundle);
    console.log(`Updated ${outputPath} (${files.length} pinned source files)`);
  } else if (mode === '--check') {
    const violations = nativeRootLicenseBundleViolations(inventory, readFileSync(outputPath));
    if (violations.length) {
      for (const violation of violations) console.error(`- ${violation}`);
      process.exitCode = 1;
    } else {
      console.log(
        `Native root-license bundle matches ${entriesFromInventory(inventory).length} pinned source files.`,
      );
    }
  } else {
    console.error('Usage: native-root-license-bundle.mjs --generate <source checkout>|--check');
    process.exitCode = 2;
  }
}
