import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { BuildOptions } from 'vite';

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
        external: ['node-pty', 'serialport', 'ssh2', 'ws'],
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
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  },
});
