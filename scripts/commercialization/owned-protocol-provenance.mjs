import { desktopPackageIdentity } from '../desktop-package-identity.mjs';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const expectedSources = (sources) => sources.map(({ path, sha256 }) => ({ path, sha256 }));
function identity(bytes, name, expected) {
  const proof = JSON.parse(bytes.toString('utf8'));
  if (
    proof.schemaVersion !== 1 ||
    proof.package !== name ||
    JSON.stringify(expectedSources(proof.sources)) !== JSON.stringify(expectedSources(expected))
  )
    throw new Error('Protocol provenance source identity differs');
  return proof;
}
async function verifyChunks(chunks, readChunk) {
  for (const chunk of chunks) {
    if (!digest.test(chunk.sha256) || hash(await readChunk(chunk.path)) !== chunk.sha256)
      throw new Error('Protocol artifact differs from build-time hash: ' + chunk.path);
  }
  return chunks;
}
export async function verifyNoVncProof(bytes, expected, readChunk, legacy = false) {
  const proof = identity(bytes, '@novnc/novnc@1.7.0', expected);
  if (expected.length !== 52) throw new Error('Review original52 noVNC inputs');
  let chunks;
  if (legacy) {
    const paths = [...new Set(proof.sources.flatMap((source) => source.chunks))].sort();
    if (
      !paths.length ||
      paths.some(
        (path) => typeof path !== 'string' || !/^assets\/[a-zA-Z0-9_.-]+\.js$/.test(path),
      ) ||
      JSON.stringify(proof.chunks.map(({ path }) => path)) !== JSON.stringify(paths)
    )
      throw new Error('Invalid legacy noVNC chunk path');
    chunks = proof.chunks;
  } else {
    if (
      typeof proof.file !== 'string' ||
      !/^novnc-[a-f0-9]{64}\.js$/.test(proof.file) ||
      proof.file !== `novnc-${proof.sha256}.js`
    )
      throw new Error('Invalid owned noVNC asset path');
    chunks = [{ path: proof.file, sha256: proof.sha256 }];
  }
  return {
    sources: expected.length,
    manifestSha256: hash(bytes),
    chunkHashes: await verifyChunks(chunks, readChunk),
  };
}
export async function verifySpiceProof(bytes, expected, readChunk, legacy = false) {
  const proof = identity(bytes, 'spice-client@1.2.0', expected.sources);
  if (
    expected.sources.length !== 30 ||
    proof.entry?.path !== 'dist/esm/index.js' ||
    proof.entry.sha256 !== expected.entrySha256 ||
    proof.sourceMapSha256 !== expected.sourceMapSha256
  )
    throw new Error('SPICE entry/source-map identity differs');
  if (
    !Array.isArray(proof.chunks) ||
    proof.chunks.length !== 1 ||
    (legacy
      ? !/^assets\/spice-client-[a-zA-Z0-9_.-]+\.js$/.test(proof.chunks[0]?.path)
      : proof.chunks[0]?.path !== 'client.browser.js')
  )
    throw new Error('Invalid SPICE factory path');
  await verifyChunks(proof.chunks, readChunk);
  return { sources: expected.sources.length, manifestSha256: hash(bytes), chunk: proof.chunks[0] };
}
/** Resolve the owning physical package, independent of checkout links or Node resolver globals. */
export async function ownedPackageDirectory(resourcesDirectory, name, expectedVersion) {
  const resources = await realpath(resourcesDirectory),
    app = await realpath(join(resources, 'app'));
  if (app !== join(resources, 'app')) throw new Error('Linked application root');
  const inventory = JSON.parse(await readFile(join(app, 'LEVEL3_PACKAGE.json'), 'utf8'));
  try {
    desktopPackageIdentity(inventory);
  } catch (cause) {
    throw new Error('Invalid application inventory', { cause });
  }
  const records = inventory.packages.filter((entry) => entry.name === name);
  if (records.length !== 1 || !/^[a-f0-9]{24}$/.test(records[0].id))
    throw new Error('Ambiguous protocol owner');
  const directory = await realpath(resolve(app, 'node_modules/.axterm', records[0].id, 'package'));
  if (!directory.startsWith(app + sep)) throw new Error('Protocol owner escapes application');
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (
    manifest.name !== records[0].name ||
    manifest.version !== records[0].version ||
    (expectedVersion !== undefined && manifest.version !== expectedVersion)
  )
    throw new Error('Protocol owner identity mismatch');
  return directory;
}
export async function ownedProtocolRoot(resourcesDirectory) {
  return join(
    await ownedPackageDirectory(resourcesDirectory, '@axterm/plugin-remote-desktop'),
    'lib',
  );
}
