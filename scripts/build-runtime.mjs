import { build } from 'esbuild';
await build({
  entryPoints: ['src/entry/headless.ts'],
  outfile: 'dist/headless.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  external: ['node-pty', 'serialport', 'ssh2'],
});
