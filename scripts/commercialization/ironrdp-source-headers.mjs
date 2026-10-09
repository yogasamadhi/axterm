import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { inventoryViolations } from './ironrdp-wasm-source-scope.mjs';
import {
  isCandidateHeaderLine,
  sourceCodeExtension,
  sourceCodeFiles,
  sourceHeaderLines,
} from './source-header-scan.mjs';

const root = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
);
const recordPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-SOURCE-HEADER-CANDIDATES-2026-09-24.json',
);
const bundlePath = resolve(root, 'licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt');
const inventorySha256 = 'ff29170ab16588b67555996ba107f15eac5005149b549110cd570fe1c4126792';
const recordSha256 = '5b9fb5eea9d123bcbe5542c6690e0b9077d4ab2adf5c20b3a44694017eb28915';
const bundleSha256 = 'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084';
const sourceCommit = 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, maxBuffer: 100 * 1024 * 1024 });
}

function archiveFor(cargoHome, entry) {
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
  if (sha256(readFileSync(matches[0].archive)) !== entry.checksum)
    throw new Error(`Locked crate archive differs: ${entry.name}@${entry.version}`);
  return matches[0];
}

export function sourceHeaderCandidateRecord(inventory, checkout, cargoHome) {
  const violations = inventoryViolations(inventory);
  if (violations.length) throw new Error(violations.join('; '));
  const upstream = resolve(checkout);
  if (command('git', ['rev-parse', 'HEAD'], upstream).toString().trim() !== sourceCommit)
    throw new Error('IronRDP header source checkout is not the pinned commit');
  if (command('git', ['status', '--porcelain', '--untracked-files=no'], upstream).toString().trim())
    throw new Error('IronRDP header source checkout has changed tracked files');
  const entries = [];
  let scannedCodeFileCount = 0;
  for (const candidate of inventory.packages) {
    const identity = `${candidate.name}@${candidate.version}`;
    const cached = candidate.source === 'registry' ? archiveFor(cargoHome, candidate) : null;
    const directory = cached?.source ?? join(upstream, candidate.path);
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
        : command('git', ['show', `${sourceCommit}:${candidate.path}/${path}`], upstream);
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
    source: 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
    sourceInventorySha256: inventorySha256,
    target: 'wasm32-unknown-unknown',
    sourcePackageCount: inventory.packages.length,
    scannedCodeFileCount,
    candidatePackageCount: new Set(entries.map(({ package: name }) => name)).size,
    candidateFileCount: entries.length,
    candidateLineCount: entries.reduce((count, entry) => count + entry.lines.length, 0),
    entries,
    limitations: [
      'This scans selected source-code extensions and explicit copyright/SPDX lines in the target-reachable normal/build source graph; it is not a complete rights or file-level license audit.',
      'Each matching file is byte-compared with its pinned published crate archive or tagged workspace commit; nonmatching files are not individually compared.',
      'Candidate inclusion does not prove linkage into the published WASM or select an applicable license alternative.',
    ],
  };
}

export function sourceHeaderBundle(record) {
  const lines = [
    'Axterm IronRDP target-source copyright/SPDX attribution candidates',
    '',
    `Source: ${record.source}; ${record.sourcePackageCount} target-reachable packages; ${record.candidateFileCount} matching code files.`,
    'This preserves exact matching source lines with file hashes and positions; it is not a full license, source-to-WASM map or legal conclusion.',
    '',
  ];
  for (const entry of record.entries) {
    lines.push(`===== ${entry.package} / ${entry.path} | SHA-256 ${entry.fileSha256} =====`);
    lines.push(...entry.lines.map(({ line, text }) => `L${line}: ${text}`));
    lines.push('');
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function sourceHeaderRecordViolations(record, inventory, bundle) {
  const violations = inventoryViolations(inventory);
  if (
    record?.schemaVersion !== 1 ||
    record.source !== 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json' ||
    record.sourceInventorySha256 !== inventorySha256 ||
    record.target !== 'wasm32-unknown-unknown' ||
    record.sourcePackageCount !== inventory.packages.length ||
    record.scannedCodeFileCount !== 6958 ||
    record.candidatePackageCount !== 51 ||
    record.candidateFileCount !== 719 ||
    record.candidateLineCount !== 798 ||
    !Array.isArray(record.entries) ||
    record.candidateFileCount !== record.entries?.length ||
    record.candidateLineCount !==
      record.entries?.reduce((count, entry) => count + (entry.lines?.length ?? 0), 0)
  ) {
    violations.push('IronRDP source-header candidate scope differs');
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
      violations.push(`Invalid source-header candidate: ${entry.package}/${entry.path}`);
    }
    observed.add(identity);
  }
  if (new Set(record.entries.map((entry) => entry.package)).size !== record.candidatePackageCount)
    violations.push('IronRDP source-header package coverage differs');
  if (!sourceHeaderBundle(record).equals(bundle))
    violations.push('IronRDP source-header attribution bundle differs');
  return violations;
}

async function formatted(record) {
  return format(JSON.stringify(record), { parser: 'json', printWidth: 100 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const inventoryText = readFileSync(inventoryPath, 'utf8');
  if (sha256(inventoryText) !== inventorySha256)
    throw new Error('IronRDP source inventory changed before header audit');
  const inventory = JSON.parse(inventoryText);
  if (mode === '--generate' || mode === '--source-check') {
    if (process.argv.length !== 4)
      throw new Error(`${mode} requires the tagged IronRDP source checkout`);
    const record = sourceHeaderCandidateRecord(
      inventory,
      process.argv[3],
      process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    );
    const json = await formatted(record);
    const bundle = sourceHeaderBundle(record);
    if (mode === '--generate') {
      writeFileSync(recordPath, json);
      writeFileSync(bundlePath, bundle);
      console.log(`Updated ${recordPath} and ${bundlePath}`);
    } else if (
      readFileSync(recordPath, 'utf8') !== json ||
      !readFileSync(bundlePath).equals(bundle)
    ) {
      throw new Error('IronRDP source-header evidence differs from pinned publisher sources');
    } else
      console.log(`${record.candidateFileCount} source-header candidates match publisher files.`);
  } else if (mode === '--check') {
    const json = readFileSync(recordPath, 'utf8');
    const bundle = readFileSync(bundlePath);
    const record = JSON.parse(json);
    const violations = sourceHeaderRecordViolations(record, inventory, bundle);
    if (json !== (await formatted(record)))
      violations.push('Source-header record formatting differs');
    if (sha256(json) !== recordSha256) violations.push('Source-header record pinned hash differs');
    if (sha256(bundle) !== bundleSha256)
      violations.push('Source-header bundle pinned hash differs');
    if (violations.length) throw new Error(violations.join('; '));
    console.log(`${record.candidateFileCount} IronRDP source-header files are byte-pinned.`);
  } else
    throw new Error(
      'Usage: ironrdp-source-headers.mjs --generate|--source-check <checkout>|--check',
    );
}
