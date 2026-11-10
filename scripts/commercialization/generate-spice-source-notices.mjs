import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { ownedProtocolRoot, verifySpiceProof } from './owned-protocol-provenance.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = resolve(
  projectRoot,
  'packages/plugins/remote-desktop/node_modules/spice-client',
);
const outputPath = resolve(projectRoot, 'licenses/spice-client-SOURCE-NOTICES.txt');
const rendererOutputRoot = resolve(projectRoot, 'packages/plugins/remote-desktop/lib');

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function leadingComments(source) {
  let offset = 0;
  const comments = [];
  while (offset < source.length) {
    while (/\s/u.test(source[offset] ?? '')) offset += 1;
    if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw new Error('Unterminated leading spice-client source comment');
      comments.push(source.slice(offset, end + 2));
      offset = end + 2;
    } else if (source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset);
      comments.push(source.slice(offset, end < 0 ? source.length : end));
      offset = end < 0 ? source.length : end + 1;
    } else {
      break;
    }
  }
  return comments.length ? comments.join('\n') : null;
}

export async function buildSpiceSourceNotices() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'spice-client' || manifest.version !== '1.2.0')
    throw new Error('Review spice-client version before regenerating source notices');
  if (manifest.exports?.['.']?.import !== './dist/esm/index.js')
    throw new Error('Review the spice-client ESM entry before regenerating source notices');
  const rendererAdapter = await readFile(
    resolve(projectRoot, 'packages/plugins/remote-desktop/src/client/ui/spice-canvas-adapter.ts'),
    'utf8',
  );
  if (!rendererAdapter.includes("import('spice-client')"))
    throw new Error('Review the production spice-client import before regenerating notices');

  const entry = await readFile(resolve(packageRoot, 'dist/esm/index.js'));
  const sourceMapBytes = await readFile(resolve(packageRoot, 'dist/esm/index.js.map'));
  if (!entry.toString('utf8').includes('//# sourceMappingURL=index.js.map'))
    throw new Error('The installed spice-client entry no longer references its source map');
  const sourceMap = JSON.parse(sourceMapBytes.toString('utf8'));
  if (
    sourceMap.version !== 3 ||
    sourceMap.file !== 'index.js' ||
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sources.length !== sourceMap.sourcesContent.length
  )
    throw new Error('Review the installed spice-client source map structure');
  const sources = sourceMap.sources.map((rawPath, index) => {
    if (typeof rawPath !== 'string' || !/^\.\.\/\.\.\/src\/spice\/[\w/-]+\.ts$/u.test(rawPath))
      throw new Error(`Unexpected spice-client source-map path: ${String(rawPath)}`);
    const content = sourceMap.sourcesContent[index];
    if (typeof content !== 'string' || !content)
      throw new Error(`Missing spice-client source content: ${rawPath}`);
    return {
      path: rawPath.slice('../../'.length),
      sha256: sha256(content),
      header: leadingComments(content),
    };
  });
  if (new Set(sources.map(({ path }) => path)).size !== sources.length)
    throw new Error('Duplicate spice-client source-map path');
  if (
    !sources.some(({ path }) => path === 'src/spice/main.ts') ||
    !sources.some(({ path }) => path === 'src/spice/thirdparty/jsbn.ts') ||
    !sources.some(({ path }) => path === 'src/spice/thirdparty/sha1.ts')
  )
    throw new Error('The spice-client source map lost expected product or embedded inputs');
  sources.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const lines = [
    `spice-client ${manifest.version} ESM source-map notices`,
    '',
    'Generated from the installed spice-client npm package used by Axterm.',
    'The ESM entry references dist/esm/index.js.map, whose sourcesContent supplies',
    'the exact source text inspected here. The hashes below identify those source',
    'texts, not separate source files in the published npm tarball.',
    `ESM entry SHA-256: ${sha256(entry)}`,
    `Source map SHA-256: ${sha256(sourceMapBytes)}`,
    `Source-map inputs: ${sources.length}.`,
    'Leading comments are preserved verbatim; a missing leading comment is',
    'reported rather than treated as evidence that a file has no notice.',
    'This is an attribution/source-review aid, not a complete corresponding-source',
    'offer, a Vite output map, or qualified LGPL/distribution clearance.',
    'See spice-client-LICENSE.txt, LGPL-3.0.txt and GPL-3.0.txt for companion texts.',
    '',
  ];
  for (const source of sources) {
    lines.push(`=== ${source.path} ===`);
    lines.push(`SHA-256: ${source.sha256}`);
    lines.push(source.header ?? '[No leading comment detected]');
    lines.push('');
  }
  return {
    content: `${lines.join('\n')}\n`,
    sources,
    entrySha256: sha256(entry),
    sourceMapSha256: sha256(sourceMapBytes),
  };
}

export async function verifySpiceRendererBundle() {
  const inventory = await buildSpiceSourceNotices();
  const bytes = await readFile(
    resolve(rendererOutputRoot, 'protocol-assets/spice-provenance.json'),
  );
  return verifySpiceProof(bytes, inventory, (path) => readFile(resolve(rendererOutputRoot, path)));
}
export async function verifySpicePackagedBundle(resourcesDirectory) {
  const inventory = await buildSpiceSourceNotices();
  const archive = resolve(resourcesDirectory, 'app.asar');
  if (!existsSync(archive)) {
    const directory = await ownedProtocolRoot(resourcesDirectory);
    const bytes = await readFile(resolve(directory, 'protocol-assets/spice-provenance.json'));
    const current = await readFile(
      resolve(rendererOutputRoot, 'protocol-assets/spice-provenance.json'),
    );
    if (!bytes.equals(current))
      throw new Error('Packaged SPICE provenance differs from current owning build');
    return verifySpiceProof(bytes, inventory, (path) => readFile(resolve(directory, path)));
  }
  const appRequire = createRequire(resolve(projectRoot, 'apps/desktop/package.json'));
  const asar = createRequire(appRequire.resolve('electron-builder'))('@electron/asar');
  const bytes = asar.extractFile(
    archive,
    'out/renderer/axterm-spice-client-bundle-provenance.json',
  );
  return {
    ...(await verifySpiceProof(
      bytes,
      inventory,
      (path) => asar.extractFile(archive, 'out/renderer/' + path),
      true,
    )),
    archiveSha256: sha256(await readFile(archive)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--bundle-check') {
    console.log(JSON.stringify(await verifySpiceRendererBundle(), null, 2));
    process.exit(0);
  }
  if (mode !== '--check' && mode !== '--generate')
    throw new Error('Use --check, --generate or --bundle-check');
  const { content, sources } = await buildSpiceSourceNotices();
  if (mode === '--generate') {
    await writeFile(outputPath, content, 'utf8');
  } else if ((await readFile(outputPath, 'utf8')) !== content) {
    throw new Error('spice-client source notices drifted from the installed ESM source map');
  }
  console.log(`Verified spice-client source notices: ${sources.length} source-map inputs.`);
}
