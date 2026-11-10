import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'tsdown';
/** Package-owned companion build: fixed noVNC has TLA and must remain an ESM protocol asset. */
export async function buildRemoteDesktopAssets(directory = import.meta.dirname) {
  const local = createRequire(join(directory, 'package.json')),
    target = join(directory, 'lib/protocol-assets'),
    temporary = join(target, '.build');
  await mkdir(temporary, { recursive: true });
  const sources = new Map();
  await build({
    entry: { novnc: local.resolve('@novnc/novnc') },
    outDir: temporary,
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    clean: true,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    minify: true,
    sourcemap: false,
    outputOptions: { codeSplitting: false },
    deps: { alwaysBundle: [/.*/] },
    plugins: [
      {
        name: 'remote-desktop-novnc-provenance',
        generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            for (const source of Object.keys(output.modules)) {
              const path = source.replaceAll('\\', '/'),
                marker = '/@novnc/novnc/',
                at = path.indexOf(marker);
              if (at >= 0) sources.set(path.slice(at + marker.length), source);
            }
          }
        },
      },
    ],
    logLevel: 'warn',
  });
  const bytes = await readFile(join(temporary, 'novnc.js'));
  if (bytes.length > 8 * 1024 * 1024) throw Error('NOVNC_ASSET_CAPACITY');
  const digest = createHash('sha256').update(bytes).digest('hex'),
    file = 'novnc-' + digest + '.js';
  await writeFile(join(target, file), bytes);
  const sourceRecords = [];
  for (const [path, filename] of [...sources].sort(([a], [b]) => a.localeCompare(b, 'en')))
    sourceRecords.push({
      path,
      sha256: createHash('sha256')
        .update(await readFile(filename))
        .digest('hex'),
    });
  if (!sources.has('core/rfb.js')) throw Error('NOVNC_PROVENANCE_MISSING');
  await writeFile(
    join(target, 'novnc-provenance.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        package: '@novnc/novnc@1.7.0',
        file,
        sha256: digest,
        sources: sourceRecords,
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(directory, 'lib/protocol-assets.json'),
    JSON.stringify({ version: 1, novnc: { file, sha256: digest, bytes: bytes.length } }, null, 2) +
      '\n',
  );
  await rm(temporary, { recursive: true, force: true });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  await buildRemoteDesktopAssets();

/** Called only by the first-party build after the actual Client factory is written. */
export async function buildSpiceClientProvenance(directory, modules) {
  const candidates = modules.filter((path) =>
    path.replaceAll('\\', '/').endsWith('/spice-client/dist/esm/index.js'),
  );
  if (candidates.length !== 1) throw new Error('SPICE_PROVENANCE_ENTRY_MISSING');
  const entryPath = candidates[0];
  const packageRoot = resolve(dirname(entryPath), '../..');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'spice-client' || manifest.version !== '1.2.0')
    throw new Error('SPICE_PROVENANCE_IDENTITY');
  const entry = await readFile(entryPath),
    mapBytes = await readFile(entryPath + '.map');
  const map = JSON.parse(mapBytes.toString('utf8'));
  if (
    map.version !== 3 ||
    map.file !== 'index.js' ||
    map.sources?.length !== 30 ||
    map.sourcesContent?.length !== 30
  )
    throw new Error('SPICE_PROVENANCE_SOURCE_MAP');
  const sources = map.sources
    .map((path, index) => {
      if (
        !/^\.\.\/\.\.\/src\/spice\/[\w/-]+\.ts$/.test(path) ||
        typeof map.sourcesContent[index] !== 'string'
      )
        throw new Error('SPICE_PROVENANCE_SOURCE');
      return {
        path: path.slice(6),
        sha256: createHash('sha256').update(map.sourcesContent[index]).digest('hex'),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(sources.map(({ path }) => path)).size !== 30)
    throw new Error('SPICE_PROVENANCE_DUPLICATE');
  const factory = await readFile(join(directory, 'lib/client.browser.js'));
  await mkdir(join(directory, 'lib/protocol-assets'), { recursive: true });
  await writeFile(
    join(directory, 'lib/protocol-assets/spice-provenance.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        package: 'spice-client@1.2.0',
        entry: {
          path: 'dist/esm/index.js',
          sha256: createHash('sha256').update(entry).digest('hex'),
        },
        sourceMapSha256: createHash('sha256').update(mapBytes).digest('hex'),
        sources,
        chunks: [
          { path: 'client.browser.js', sha256: createHash('sha256').update(factory).digest('hex') },
        ],
      },
      null,
      2,
    ) + '\n',
  );
}
