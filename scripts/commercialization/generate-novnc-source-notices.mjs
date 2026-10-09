import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = resolve(projectRoot, 'apps/desktop/node_modules/@novnc/novnc');
const outputPath = resolve(projectRoot, 'licenses/noVNC-SOURCE-NOTICES.txt');
const rendererOutputRoot = resolve(projectRoot, 'apps/desktop/out/renderer');
const packageMarker = '/@novnc/novnc/';

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function leadingLegalComment(source) {
  let offset = 0;
  const comments = [];
  while (offset < source.length) {
    while (/\s/u.test(source[offset] ?? '')) offset += 1;
    let comment;
    if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw new Error('Unterminated leading noVNC source comment');
      comment = source.slice(offset, end + 2);
      offset = end + 2;
    } else if (source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset);
      comment = source.slice(offset, end < 0 ? source.length : end);
      offset = end < 0 ? source.length : end + 1;
    } else {
      break;
    }
    if (!/copyright|licen[cs]e|SPDX|From:/iu.test(comment)) break;
    comments.push(comment);
  }
  return comments.length ? comments.join('\n') : null;
}

export async function buildNoVncSourceNotices() {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@novnc/novnc' || manifest.version !== '1.7.0')
    throw new Error('Review noVNC version before regenerating its source notices');
  if (manifest.exports !== './core/rfb.js')
    throw new Error('Review the noVNC package entry before regenerating source notices');
  const rendererAdapter = await readFile(
    resolve(projectRoot, 'apps/desktop/src/renderer/src/components/vnc-canvas-adapter.ts'),
    'utf8',
  );
  if (!rendererAdapter.includes("import('@novnc/novnc')"))
    throw new Error('Review the production noVNC import before regenerating source notices');

  const bundled = await build({
    absWorkingDir: projectRoot,
    entryPoints: [resolve(packageRoot, 'core/rfb.js')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  const modulePaths = Object.keys(bundled.metafile.inputs)
    .map((input) => ({
      input,
      path: input.replaceAll('\\', '/').split(packageMarker)[1],
    }))
    .sort((left, right) => (left.path ?? '').localeCompare(right.path ?? '', 'en'));
  if (modulePaths.some(({ path }) => !path))
    throw new Error('The noVNC entry imports a module outside the installed noVNC package');

  const modules = await Promise.all(
    modulePaths.map(async ({ input, path }) => {
      const contents = await readFile(resolve(projectRoot, input));
      return {
        path,
        sha256: sha256(contents),
        header: leadingLegalComment(contents.toString('utf8')),
      };
    }),
  );
  const coreCount = modules.filter(({ path }) => path.startsWith('core/')).length;
  const pakoCount = modules.filter(({ path }) => path.startsWith('vendor/pako/')).length;
  if (!coreCount || !pakoCount)
    throw new Error('The noVNC source closure no longer includes expected core and Pako modules');

  const lines = [
    `noVNC ${manifest.version} RFB import-graph source notices`,
    '',
    'Generated from the installed @novnc/novnc package used by Axterm.',
    'Entry: core/rfb.js; closure: esbuild browser ESM module inputs.',
    `Inputs: ${modules.length} total; ${coreCount} core; ${pakoCount} vendor/pako.`,
    'Each SHA-256 identifies the exact installed source file inspected.',
    'A header below preserves its leading legal/source-origin comments.',
    'Files without such a leading comment are listed, not assumed notice-free.',
    'This is an audit aid, not a Vite output map or qualified rights clearance.',
    'See noVNC-LICENSE.txt, noVNC-AUTHORS.txt, noVNC-DES-NOTICE.txt,',
    'noVNC-pako-LICENSE.txt and MPL-2.0.txt for companion legal material.',
    '',
  ];
  for (const module of modules) {
    lines.push(`=== ${module.path} ===`);
    lines.push(`SHA-256: ${module.sha256}`);
    lines.push(module.header ?? '[No leading legal/source-origin comment detected]');
    lines.push('');
  }
  return { content: `${lines.join('\n')}\n`, modules, coreCount, pakoCount };
}

export async function verifyNoVncRendererBundle() {
  const { modules } = await buildNoVncSourceNotices();
  const manifestBytes = await readFile(
    resolve(rendererOutputRoot, 'axterm-novnc-bundle-provenance.json'),
  );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.package !== '@novnc/novnc@1.7.0')
    throw new Error('Unexpected noVNC Vite bundle provenance schema or package version');
  const expected = modules.map(({ path, sha256 }) => ({ path, sha256 }));
  const observed = manifest.sources?.map(({ path, sha256 }) => ({ path, sha256 }));
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    throw new Error('Vite noVNC source inputs differ from the installed RFB notice archive');

  const chunks = [...new Set(manifest.sources.flatMap(({ chunks: paths }) => paths))].sort();
  if (!chunks.length || chunks.some((path) => !/^assets\/[a-zA-Z0-9_.-]+\.js$/u.test(path)))
    throw new Error('Invalid noVNC Vite chunk path');
  const chunkHashes = await Promise.all(
    chunks.map(async (path) => ({
      path,
      sha256: sha256(await readFile(resolve(rendererOutputRoot, path))),
    })),
  );
  if (JSON.stringify(manifest.chunks) !== JSON.stringify(chunkHashes))
    throw new Error('The emitted noVNC Vite chunk bytes differ from their build-time hashes');
  return { sources: observed.length, manifestSha256: sha256(manifestBytes), chunkHashes };
}

export async function verifyNoVncPackagedBundle(resourcesDirectory) {
  const appRequire = createRequire(resolve(projectRoot, 'apps/desktop/package.json'));
  const builderRequire = createRequire(appRequire.resolve('electron-builder'));
  const asar = builderRequire('@electron/asar');
  const archive = resolve(resourcesDirectory, 'app.asar');
  const manifestBytes = asar.extractFile(
    archive,
    'out/renderer/axterm-novnc-bundle-provenance.json',
  );
  const sourceManifest = await readFile(
    resolve(rendererOutputRoot, 'axterm-novnc-bundle-provenance.json'),
  );
  if (!manifestBytes.equals(sourceManifest))
    throw new Error('Packaged noVNC provenance differs from the current renderer build');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const sourceResult = await verifyNoVncRendererBundle();
  for (const chunk of manifest.chunks) {
    const packagedBytes = asar.extractFile(archive, `out/renderer/${chunk.path}`);
    if (sha256(packagedBytes) !== chunk.sha256)
      throw new Error(`Packaged noVNC chunk differs from its build-time hash: ${chunk.path}`);
  }
  return {
    sources: sourceResult.sources,
    manifestSha256: sha256(manifestBytes),
    archiveSha256: sha256(await readFile(archive)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--bundle-check') {
    console.log(JSON.stringify(await verifyNoVncRendererBundle(), null, 2));
    process.exit(0);
  }
  if (mode !== '--check' && mode !== '--generate') throw new Error('Use --check or --generate');
  const { content, modules, coreCount, pakoCount } = await buildNoVncSourceNotices();
  if (mode === '--generate') {
    await writeFile(outputPath, content, 'utf8');
  } else {
    const existing = await readFile(outputPath, 'utf8');
    if (existing !== content)
      throw new Error('noVNC source notice archive drifted from installed RFB import graph');
  }
  console.log(
    `Verified noVNC source notices: ${modules.length} inputs, ${coreCount} core, ${pakoCount} Pako.`,
  );
}
