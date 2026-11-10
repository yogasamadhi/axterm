// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Factory artifact layout adapted from packages/client/tsdown.client.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBuiltin } from 'node:module';
import { build } from 'tsdown';
import { ownedClientCss } from './client-css.mjs';
import { CLIENT_PLATFORM_MODULES } from './client-platform.mjs';

/** Build an independently loadable Client factory without duplicating shared identities. */
export async function buildClientBundle(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const requested = new Set([
    ...CLIENT_PLATFORM_MODULES,
    ...(manifest.axterm?.client?.external ?? []),
  ]);
  const declared = new Set(
    ['dependencies', 'peerDependencies', 'devDependencies'].flatMap((key) =>
      Object.keys(manifest[key] ?? {}),
    ),
  );
  const protocolInputs = new Set();
  const packageOf = (value) =>
    value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];
  await build({
    entry: { 'client.browser': join(directory, 'lib/types/client/index.js') },
    outDir: join(directory, 'lib'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    sourcemap: true,
    deps: {
      neverBundle: (name) => requested.has(name),
      alwaysBundle: (name) => !requested.has(name),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.MODE': '"production"',
      'import.meta.env': '{"MODE":"production"}',
    },
    plugins: [
      ownedClientCss(directory),
      {
        name: 'axterm-client-capability-boundary',
        generateBundle(_options, bundle) {
          if (manifest.name !== '@axterm/plugin-remote-desktop') return;
          for (const output of Object.values(bundle))
            if (output.type === 'chunk')
              for (const path of Object.keys(output.modules))
                if (path.replaceAll('\\', '/').includes('/spice-client/dist/esm/'))
                  protocolInputs.add(path);
        },
        resolveId(name) {
          if (isBuiltin(name))
            throw new Error(`Client bundle cannot import native module: ${name}`);
          if (
            name.startsWith('@axterm/') &&
            !declared.has(packageOf(name)) &&
            packageOf(name) !== manifest.name
          )
            throw new Error(`Client bundle has undeclared dependency: ${name}`);
          if (
            name.startsWith('@axterm/plugin-') &&
            packageOf(name) !== manifest.name &&
            !requested.has(name)
          )
            throw new Error(`Client bundle cannot inline another business plugin: ${name}`);
          return null;
        },
      },
    ],
    outputOptions: {
      codeSplitting: false,
      entryFileNames: 'client.browser.js',
      chunkFileNames: 'client.browser.[name]-[hash].js',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      banner: (chunk) =>
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
      footer: 'return module.exports; } });',
    },
    logLevel: 'warn',
  });
  if (manifest.name === '@axterm/plugin-remote-desktop') {
    const { buildSpiceClientProvenance } =
      await import('../packages/plugins/remote-desktop/build-client-assets.mjs');
    await buildSpiceClientProvenance(directory, [...protocolInputs]);
  }
}
