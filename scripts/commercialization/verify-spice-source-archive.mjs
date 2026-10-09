import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpiceSourceNotices } from './generate-spice-source-notices.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const archivePath = resolve(projectRoot, 'licenses/spice-client-1.2.0-source.tar');
const packageRoot = resolve(projectRoot, 'apps/desktop/node_modules/spice-client');
const upstreamCommit = 'aed3b4f841db65a9ab015e174d69ff4fccbb197f';
const archiveSha256 = 'a30adf3706f5a03ede1fdcd0785cea4330f86af2c9bbbc75165384ccfcfd9a26';
const archivePrefix = 'spice-client-1.2.0/';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function tarText(bytes, start, end) {
  return bytes.toString('utf8', start, end).split('\0', 1)[0];
}

export function inspectSpiceSourceTar(bytes) {
  const files = new Map();
  let commit = null;
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.subarray(offset).some((byte) => byte !== 0))
        throw new Error('Spice source tar has nonzero bytes after its trailer');
      return { files, commit };
    }
    const prefix = tarText(header, 345, 500);
    const name = `${prefix ? `${prefix}/` : ''}${tarText(header, 0, 100)}`;
    const sizeField = tarText(header, 124, 136).trim();
    if (!/^[0-7]+$/u.test(sizeField)) throw new Error(`Invalid spice tar size: ${name}`);
    const size = Number.parseInt(sizeField, 8);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > bytes.length)
      throw new Error(`Truncated spice tar entry: ${name}`);
    const content = bytes.subarray(start, end);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === 'g' && name === 'pax_global_header') {
      const match = /^\d+ comment=([0-9a-f]{40})\n$/u.exec(content.toString('utf8'));
      if (!match || commit !== null) throw new Error('Unexpected spice tar commit header');
      commit = match[1];
    } else if (type === '5') {
      if (!name.startsWith(archivePrefix) || !name.endsWith('/') || size !== 0)
        throw new Error(`Unsafe spice tar directory: ${name}`);
    } else if (type === '0' || type === '\0') {
      if (
        !name.startsWith(archivePrefix) ||
        name.endsWith('/') ||
        name.split('/').includes('..') ||
        files.has(name)
      )
        throw new Error(`Unsafe or duplicate spice tar file: ${name}`);
      files.set(name.slice(archivePrefix.length), content);
    } else {
      throw new Error(`Unexpected spice tar entry type: ${name}`);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('Spice source tar has no complete trailer');
}

export async function verifySpiceSourceArchive(inputBytes) {
  const bytes = inputBytes ?? (await readFile(archivePath));
  if (sha256(bytes) !== archiveSha256)
    throw new Error('Spice source archive differs from the reviewed commit snapshot');
  const { files, commit } = inspectSpiceSourceTar(bytes);
  if (commit !== upstreamCommit) throw new Error('Unexpected spice source commit');
  if (files.size !== 50) throw new Error('Unexpected spice source archive file count');
  const inventory = await buildSpiceSourceNotices();
  for (const { path, sha256: expected } of inventory.sources) {
    const contents = files.get(path);
    if (!contents || sha256(contents) !== expected)
      throw new Error(`Spice source archive differs from the installed source map: ${path}`);
  }
  for (const path of ['LICENSE', 'package.json']) {
    const installed = await readFile(resolve(packageRoot, path));
    if (!files.get(path)?.equals(installed))
      throw new Error(`Spice source archive differs from installed package: ${path}`);
  }
  for (const path of [
    'build/vite.config.ts',
    'build/tsconfig.types.json',
    'package-lock.json',
    'tsconfig.json',
    'src/spice/index.ts',
  ]) {
    if (!files.has(path)) throw new Error(`Spice source archive lacks build input: ${path}`);
  }
  return {
    archiveSha256,
    upstreamCommit,
    files: files.size,
    matchingMappedSources: inventory.sources.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--check') throw new Error('Use --check');
  console.log(JSON.stringify(await verifySpiceSourceArchive(), null, 2));
}
