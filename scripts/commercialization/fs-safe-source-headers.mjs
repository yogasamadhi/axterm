import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  isCandidateHeaderLine,
  sourceCodeExtension,
  sourceCodeFiles,
  sourceHeaderLines,
} from './source-header-scan.mjs';

const root = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  root,
  'docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
);
const recordPath = resolve(
  root,
  'docs/implementation/evidence/IR11-FS-SAFE-SOURCE-HEADER-CANDIDATES-2026-09-24.json',
);
const bundlePath = resolve(root, 'licenses/fs-safe-SOURCE-HEADER-ATTRIBUTIONS.txt');
const inventorySha256 = '5383b6ebd6d9f8cc430f925b11de03e0def26a6b8d7856283e1a26b56cdcc81b';
const recordSha256 = '013a6d6447d5650991da26fc134c3d5578a8c8f345a8934fcd54d5676f052c83';
const bundleSha256 = '52186f73b215d7863766c152499f6bb2caea70187f8e6fe7165a4f6c65a95a8a';
const sourceCommit = '7022a0a10c53e36f34a467df68ed5614a1db1741';
const lockSha256 = 'd169c18102ef5a465cf645ceecc15956aafd2f694031d2006284bbcb59284bbd';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, maxBuffer: 100 * 1024 * 1024 });
}

function sourceScope(inventory) {
  if (
    inventory?.schemaVersion !== 1 ||
    inventory.source?.commit !== sourceCommit ||
    inventory.source?.cargoLockSha256 !== lockSha256 ||
    inventory.target !== 'aarch64-apple-darwin' ||
    inventory.packageCount !== 61 ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length !== 61
  ) {
    throw new Error('Unsupported fs-safe macOS source inventory');
  }
  const identities = new Set();
  for (const entry of inventory.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (
      identities.has(identity) ||
      !['registry', 'tag-source'].includes(entry.source) ||
      !entry.name ||
      !entry.version
    ) {
      throw new Error(`Invalid fs-safe source package: ${identity}`);
    }
    identities.add(identity);
  }
}

function lockChecksums(checkout) {
  const lock = readFileSync(join(checkout, 'Cargo.lock'));
  if (sha256(lock) !== lockSha256) throw new Error('fs-safe Cargo.lock differs from pinned source');
  const result = new Map();
  for (const block of lock.toString('utf8').split('\n[[package]]\n').slice(1)) {
    const name = /^name = "([^"]+)"$/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"$/mu.exec(block)?.[1];
    const checksum = /^checksum = "([a-f0-9]{64})"$/mu.exec(block)?.[1];
    if (!name || !version) throw new Error('Invalid fs-safe Cargo.lock package block');
    if (checksum) result.set(`${name}@${version}`, checksum);
  }
  return result;
}

function archiveFor(cargoHome, entry, checksums) {
  const cache = join(cargoHome, 'registry', 'cache');
  const matches = readdirSync(cache)
    .filter((name) => name.startsWith('index.crates.io-'))
    .map((name) => ({
      archive: join(cache, name, `${entry.name}-${entry.version}.crate`),
      source: join(cargoHome, 'registry', 'src', name, `${entry.name}-${entry.version}`),
    }))
    .filter(({ archive, source }) => existsSync(archive) && existsSync(source));
  if (matches.length !== 1)
    throw new Error(`Expected one cached crate: ${entry.name}@${entry.version}`);
  if (sha256(readFileSync(matches[0].archive)) !== checksums.get(`${entry.name}@${entry.version}`))
    throw new Error(`Locked crate archive differs: ${entry.name}@${entry.version}`);
  return matches[0];
}

function taggedPackagePath(entry) {
  if (entry.name === 'fs-safe-native') return 'native';
  if (entry.name === 'fs-safe-archive-core') return 'archive-core';
  throw new Error(`Unexpected tagged source package: ${entry.name}`);
}

export function fsSafeSourceHeaderCandidateRecord(inventory, checkout, cargoHome) {
  sourceScope(inventory);
  const upstream = resolve(checkout);
  if (command('git', ['rev-parse', 'HEAD'], upstream).toString().trim() !== sourceCommit)
    throw new Error('fs-safe header source checkout is not the pinned commit');
  if (command('git', ['status', '--porcelain', '--untracked-files=no'], upstream).toString().trim())
    throw new Error('fs-safe header source checkout has changed tracked files');
  const checksums = lockChecksums(upstream);
  const entries = [];
  let scannedCodeFileCount = 0;
  for (const candidate of inventory.packages) {
    const identity = `${candidate.name}@${candidate.version}`;
    const cached =
      candidate.source === 'registry' ? archiveFor(cargoHome, candidate, checksums) : null;
    const taggedPath = cached ? null : taggedPackagePath(candidate);
    const directory = cached?.source ?? join(upstream, taggedPath);
    const paths = sourceCodeFiles(directory);
    scannedCodeFileCount += paths.length;
    for (const path of paths) {
      const bytes = readFileSync(join(directory, path));
      const lines = sourceHeaderLines(bytes);
      if (!lines.length) continue;
      const publisherBytes = cached
        ? command(
            'tar',
            ['-xOf', cached.archive, `${candidate.name}-${candidate.version}/${path}`],
            root,
          )
        : command('git', ['show', `${sourceCommit}:${taggedPath}/${path}`], upstream);
      if (!bytes.equals(publisherBytes))
        throw new Error(`Candidate source file differs from publisher: ${identity}/${path}`);
      entries.push({
        package: identity,
        source: candidate.source,
        path,
        fileSha256: sha256(bytes),
        lines,
      });
    }
  }
  entries.sort((left, right) =>
    `${left.package}/${left.path}`.localeCompare(`${right.package}/${right.path}`),
  );
  return {
    schemaVersion: 1,
    source: 'IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json',
    sourceInventorySha256: inventorySha256,
    target: inventory.target,
    sourcePackageCount: inventory.packages.length,
    scannedCodeFileCount,
    candidatePackageCount: new Set(entries.map(({ package: name }) => name)).size,
    candidateFileCount: entries.length,
    candidateLineCount: entries.reduce((count, entry) => count + entry.lines.length, 0),
    entries,
    limitations: [
      'This scans selected source-code extensions and explicit copyright/SPDX lines in the macOS normal-source graph; it is not a complete rights or file-level license audit.',
      'Each matching file is byte-compared with its locked published crate archive or tagged upstream commit; nonmatching files are not individually compared.',
      'Candidate inclusion does not prove linkage into the published native binary or select an applicable license alternative.',
    ],
  };
}

export function fsSafeSourceHeaderBundle(record) {
  const lines = [
    'Axterm fs-safe macOS source copyright/SPDX attribution candidates',
    '',
    `Source: ${record.source}; ${record.sourcePackageCount} target-reachable packages; ${record.candidateFileCount} matching code files.`,
    'This preserves exact matching source lines with file hashes and positions; it is not a full license, source-to-binary map or legal conclusion.',
    '',
  ];
  for (const entry of record.entries) {
    lines.push(`===== ${entry.package} / ${entry.path} | SHA-256 ${entry.fileSha256} =====`);
    lines.push(...entry.lines.map(({ line, text }) => `L${line}: ${text}`));
    lines.push('');
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function fsSafeSourceHeaderRecordViolations(record, inventory, bundle) {
  sourceScope(inventory);
  const violations = [];
  if (
    record?.schemaVersion !== 1 ||
    record.source !== 'IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json' ||
    record.sourceInventorySha256 !== inventorySha256 ||
    record.target !== inventory.target ||
    record.sourcePackageCount !== inventory.packages.length ||
    record.scannedCodeFileCount !== 2157 ||
    record.candidatePackageCount !== 9 ||
    record.candidateFileCount !== 156 ||
    record.candidateLineCount !== 156 ||
    !Array.isArray(record.entries) ||
    record.candidateFileCount !== record.entries?.length ||
    record.candidateLineCount !==
      record.entries?.reduce((count, entry) => count + (entry.lines?.length ?? 0), 0)
  ) {
    violations.push('fs-safe source-header candidate scope differs');
    return violations;
  }
  const identities = new Set(inventory.packages.map(({ name, version }) => `${name}@${version}`));
  const observed = new Set();
  for (const entry of record.entries) {
    const identity = `${entry.package}/${entry.path}`;
    if (
      !identities.has(entry.package) ||
      observed.has(identity) ||
      !/^[a-f0-9]{64}$/u.test(entry.fileSha256) ||
      !entry.path ||
      entry.path.startsWith('/') ||
      entry.path.split('/').includes('..') ||
      !sourceCodeExtension.test(entry.path) ||
      !Array.isArray(entry.lines) ||
      !entry.lines.length ||
      entry.lines.some(
        (line) =>
          !Number.isSafeInteger(line.line) ||
          line.line < 1 ||
          typeof line.text !== 'string' ||
          !isCandidateHeaderLine(line.text),
      )
    ) {
      violations.push(`Invalid fs-safe source-header candidate: ${identity}`);
    }
    observed.add(identity);
  }
  if (new Set(record.entries.map((entry) => entry.package)).size !== record.candidatePackageCount)
    violations.push('fs-safe source-header package coverage differs');
  if (!fsSafeSourceHeaderBundle(record).equals(bundle))
    violations.push('fs-safe source-header attribution bundle differs');
  return violations;
}

export function fsSafeHeaderCandidatesByPackage(record) {
  const result = new Map();
  for (const entry of record.entries) {
    const files = result.get(entry.package) ?? [];
    files.push(entry);
    result.set(entry.package, files);
  }
  return new Map(
    [...result].map(([identity, entries]) => [
      identity,
      {
        fileCount: entries.length,
        lineCount: entries.reduce((count, entry) => count + entry.lines.length, 0),
        sha256: sha256(JSON.stringify(entries)),
      },
    ]),
  );
}

async function formatted(record) {
  return format(JSON.stringify(record), { parser: 'json', printWidth: 100 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const inventoryText = readFileSync(inventoryPath, 'utf8');
  if (sha256(inventoryText) !== inventorySha256)
    throw new Error('fs-safe source inventory changed before header audit');
  const inventory = JSON.parse(inventoryText);
  if (mode === '--generate' || mode === '--source-check') {
    if (process.argv.length !== 4)
      throw new Error(`${mode} requires the tagged fs-safe source checkout`);
    const record = fsSafeSourceHeaderCandidateRecord(
      inventory,
      process.argv[3],
      process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    );
    const json = await formatted(record);
    const bundle = fsSafeSourceHeaderBundle(record);
    if (mode === '--generate') {
      writeFileSync(recordPath, json);
      writeFileSync(bundlePath, bundle);
      console.log(`Updated ${recordPath} and ${bundlePath}`);
    } else if (
      readFileSync(recordPath, 'utf8') !== json ||
      !readFileSync(bundlePath).equals(bundle)
    ) {
      throw new Error('fs-safe source-header evidence differs from pinned publisher sources');
    } else
      console.log(`${record.candidateFileCount} source-header candidates match publisher files.`);
  } else if (mode === '--check') {
    const json = readFileSync(recordPath, 'utf8');
    const bundle = readFileSync(bundlePath);
    const record = JSON.parse(json);
    const violations = fsSafeSourceHeaderRecordViolations(record, inventory, bundle);
    if (json !== (await formatted(record)))
      violations.push('fs-safe source-header record formatting differs');
    if (sha256(json) !== recordSha256)
      violations.push('fs-safe source-header record pinned hash differs');
    if (sha256(bundle) !== bundleSha256)
      violations.push('fs-safe source-header bundle pinned hash differs');
    if (violations.length) throw new Error(violations.join('; '));
    console.log(`${record.candidateFileCount} fs-safe source-header files are byte-pinned.`);
  } else
    throw new Error(
      'Usage: fs-safe-source-headers.mjs --generate|--source-check <checkout>|--check',
    );
}
