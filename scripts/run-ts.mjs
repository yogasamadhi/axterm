/**
 * Runs a workspace TypeScript entry point with Node.
 *
 * The workspace sources are TypeScript. Node loads them directly with its
 * TypeScript support, and `scripts/register-ts-resolver.mjs` restores the
 * extension-less relative imports that the sources use. No bundler and no
 * package-manager-specific runtime is involved.
 */
import { spawn } from 'node:child_process';

const [entry, ...argumentsList] = process.argv.slice(2);

if (!entry) {
  console.error('Usage: node scripts/run-ts.mjs <entry.ts> [...arguments]');
  process.exit(2);
}

const resolver = new URL('./register-ts-resolver.mjs', import.meta.url).href;

const child = spawn(
  process.execPath,
  [
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    '--import',
    resolver,
    entry,
    ...argumentsList,
  ],
  { stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(`Failed to run ${entry}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
