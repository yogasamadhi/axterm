import { loaderCspCompiler } from '../../scripts/loader-csp-compiler.mjs';
import { retainBootstrapCss } from '../../scripts/retain-bootstrap-css.mjs';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { validatePlatformSeed } from '../../scripts/client-platform.mjs';
import { readFileSync } from 'node:fs';
// Fail the build if static seeding and separately built factory externals drift.
await validatePlatformSeed(readFileSync(new URL('./src/seed.ts', import.meta.url), 'utf8'));
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [
    loaderCspCompiler(fileURLToPath(new URL('../../', import.meta.url))),
    retainBootstrapCss(fileURLToPath(new URL('../../', import.meta.url))),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        find: /^node:module$/,
        replacement: fileURLToPath(new URL('./src/node-module-stub.ts', import.meta.url)),
      },
    ],
  },
  define: {
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
  build: {
    target: 'es2024',
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        auth: fileURLToPath(new URL('./auth.html', import.meta.url)),
      },
    },
  },
});
