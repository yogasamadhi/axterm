import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildNoVncSourceNotices } from './generate-novnc-source-notices.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const archivePath = resolve(projectRoot, 'licenses/noVNC-1.7.0-source.tgz');
const packageRoot = resolve(projectRoot, 'apps/desktop/node_modules/@novnc/novnc');
const expectedSha256 = '32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903';
const expectedIntegrity =
  'ucEJOx4T2avIRCleodk7YobZj5O2Ga2AeLfQ69A/yjG9HHba2+PDgwSkN3FttrmG+70ZGx21sElNFouK13RzyA==';

function hash(bytes, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function field(header, start, end) {
  return header.toString('utf8', start, end).split('\0', 1)[0];
}

export function inspectNoVncSourceTar(bytes) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.subarray(offset).some((byte) => byte !== 0))
        throw new Error('noVNC source tar has nonzero bytes after its trailer');
      return files;
    }
    const prefix = field(header, 345, 500);
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    const sizeField = field(header, 124, 136).trim();
    if (!/^[0-7]+$/u.test(sizeField)) throw new Error(`Invalid noVNC tar size: ${name}`);
    const size = Number.parseInt(sizeField, 8);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > bytes.length)
      throw new Error(`Truncated noVNC tar entry: ${name}`);
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== '0' && type !== '\0') throw new Error(`Unexpected noVNC tar type: ${name}`);
    if (!name.startsWith('package/') || name.endsWith('/') || name.split('/').includes('..'))
      throw new Error(`Unsafe noVNC tar path: ${name}`);
    const relative = name.slice('package/'.length);
    if (files.has(relative)) throw new Error(`Duplicate noVNC tar path: ${name}`);
    files.set(relative, bytes.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('noVNC source tar has no complete trailer');
}

async function installedFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...(await installedFiles(join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected installed noVNC file type: ${relative}`);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function verifyNoVncSourceArchive(inputBytes) {
  const archive = inputBytes ?? (await readFile(archivePath));
  if (hash(archive) !== expectedSha256)
    throw new Error('noVNC source archive differs from the reviewed npm tarball');
  if (hash(archive, 'sha512', 'base64') !== expectedIntegrity)
    throw new Error('noVNC source archive differs from the locked npm integrity');
  const lock = await readFile(resolve(projectRoot, 'bun.lock'), 'utf8');
  const lockedPackage = lock
    .split('\n')
    .find((line) => /^\s*"@novnc\/novnc": \["@novnc\/novnc@1\.7\.0",/u.test(line));
  if (!lockedPackage?.includes(`"sha512-${expectedIntegrity}"`))
    throw new Error('The Bun lock no longer pins this exact noVNC tarball');
  const files = inspectNoVncSourceTar(gunzipSync(archive));
  const installed = await installedFiles(packageRoot);
  const archivedPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  if (files.size !== 66 || JSON.stringify(archivedPaths) !== JSON.stringify(installed))
    throw new Error('noVNC npm archive file list differs from the installed package');
  for (const path of installed) {
    const packaged = files.get(path);
    if (!packaged?.equals(await readFile(resolve(packageRoot, path))))
      throw new Error(`noVNC npm archive bytes differ from installed package: ${path}`);
  }
  const manifest = JSON.parse(files.get('package.json').toString('utf8'));
  if (manifest.name !== '@novnc/novnc' || manifest.version !== '1.7.0')
    throw new Error('Unexpected noVNC source package identity');
  for (const path of ['LICENSE.txt', 'AUTHORS', 'vendor/pako/LICENSE', 'docs/LICENSE.MPL-2.0']) {
    if (!files.has(path)) throw new Error(`noVNC source archive lacks legal file: ${path}`);
  }
  const { modules } = await buildNoVncSourceNotices();
  for (const module of modules) {
    if (hash(files.get(module.path) ?? Buffer.alloc(0)) !== module.sha256)
      throw new Error(`noVNC source archive differs from RFB import graph: ${module.path}`);
  }
  return {
    sha256: expectedSha256,
    npmIntegrity: `sha512-${expectedIntegrity}`,
    files: files.size,
    matchingRfbSources: modules.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--check') throw new Error('Use --check');
  console.log(JSON.stringify(await verifyNoVncSourceArchive(), null, 2));
}
