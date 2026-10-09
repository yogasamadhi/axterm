import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { BuildOptions, Plugin } from 'vite';

function noVncBundleProvenance(): Plugin {
  return {
    name: 'axterm-novnc-bundle-provenance',
    generateBundle(_output, bundle) {
      const sources = new Map<string, { sha256: string; chunks: Set<string> }>();
      const chunkHashes = new Map<string, string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunkHashes.set(
          output.fileName,
          createHash('sha256').update(output.code, 'utf8').digest('hex'),
        );
        for (const id of Object.keys(output.modules)) {
          const normalized = id.replaceAll('\\', '/');
          const marker = '/@novnc/novnc/';
          const index = normalized.indexOf(marker);
          if (index < 0) continue;
          const path = normalized.slice(index + marker.length).split('?')[0]!;
          const sourcePath = id.split('?')[0]!;
          const sha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
          const prior = sources.get(path);
          if (prior && prior.sha256 !== sha256)
            throw new Error(`noVNC source hash changed within one build: ${path}`);
          if (prior) prior.chunks.add(output.fileName);
          else sources.set(path, { sha256, chunks: new Set([output.fileName]) });
        }
      }
      if (
        !sources.has('core/rfb.js') ||
        ![...sources.keys()].some((path) => path.startsWith('vendor/pako/'))
      )
        throw new Error('The Vite renderer bundle lost its expected noVNC RFB/Pako source map');
      const document = {
        schemaVersion: 1,
        package: '@novnc/novnc@1.7.0',
        sources: [...sources]
          .sort(([left], [right]) => left.localeCompare(right, 'en'))
          .map(([path, { sha256, chunks }]) => ({
            path,
            sha256,
            chunks: [...chunks].sort(),
          })),
        chunks: [...new Set([...sources.values()].flatMap(({ chunks }) => [...chunks]))]
          .sort()
          .map((path) => ({ path, sha256: chunkHashes.get(path) })),
      };
      this.emitFile({
        type: 'asset',
        fileName: 'axterm-novnc-bundle-provenance.json',
        source: `${JSON.stringify(document, null, 2)}\n`,
      });
    },
  };
}

function spiceClientBundleProvenance(): Plugin {
  return {
    name: 'axterm-spice-client-bundle-provenance',
    generateBundle(_output, bundle) {
      const matching = Object.values(bundle).flatMap((output) => {
        if (output.type !== 'chunk') return [];
        const entries = Object.keys(output.modules)
          .map((id) => id.split('?')[0]!)
          .filter((id) => id.replaceAll('\\', '/').endsWith('/spice-client/dist/esm/index.js'));
        return entries.map((entry) => ({
          entry,
          chunk: output.fileName,
          chunkSha256: createHash('sha256').update(output.code, 'utf8').digest('hex'),
        }));
      });
      if (matching.length !== 1)
        throw new Error('The Vite renderer bundle lost its unique spice-client ESM source');
      const { entry, chunk, chunkSha256 } = matching[0]!;
      const sourceMapBytes = readFileSync(`${entry}.map`);
      const sourceMap = JSON.parse(sourceMapBytes.toString('utf8')) as {
        sources: string[];
        sourcesContent: string[];
      };
      if (
        !Array.isArray(sourceMap.sources) ||
        !Array.isArray(sourceMap.sourcesContent) ||
        sourceMap.sources.length !== sourceMap.sourcesContent.length
      )
        throw new Error('The Vite spice-client source map lacks matching source contents');
      const document = {
        schemaVersion: 1,
        package: 'spice-client@1.2.0',
        entry: {
          path: 'dist/esm/index.js',
          sha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
        },
        sourceMapSha256: createHash('sha256').update(sourceMapBytes).digest('hex'),
        sources: sourceMap.sources
          .map((path, index) => ({
            path: path.replace(/^\.\.\/\.\.\//u, ''),
            sha256: createHash('sha256')
              .update(sourceMap.sourcesContent[index]!, 'utf8')
              .digest('hex'),
          }))
          .sort((left, right) => left.path.localeCompare(right.path, 'en')),
        chunks: [{ path: chunk, sha256: chunkSha256 }],
      };
      this.emitFile({
        type: 'asset',
        fileName: 'axterm-spice-client-bundle-provenance.json',
        source: `${JSON.stringify(document, null, 2)}\n`,
      });
    },
  };
}

const rollupWarningFilter = {
  onLog(level, log, handler) {
    const normalizedId = log.id?.replaceAll('\\', '/');
    const isAffectedZodModule =
      normalizedId?.endsWith('/node_modules/zod/v4/core/regexes.js') === true ||
      normalizedId?.endsWith('/node_modules/zod/v4/core/util.js') === true;

    if (log.code === 'INVALID_ANNOTATION' && isAffectedZodModule) return;
    handler(level, log);
  },
} satisfies NonNullable<BuildOptions['rollupOptions']>;

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        ...rollupWarningFilter,
        external: [/^@openclaw\/fs-safe(?:\/.*)?$/u, 'node-pty', 'serialport', 'ssh2', 'ws'],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        ...rollupWarningFilter,
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    build: {
      minify: true,
      rollupOptions: {
        ...rollupWarningFilter,
        output: {
          manualChunks(id) {
            if (id.includes('/spice-client/')) return 'spice-client';
          },
        },
      },
    },
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), noVncBundleProvenance(), spiceClientBundleProvenance()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' data: http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; frame-src axterm-license:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  },
});
