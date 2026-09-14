import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assertElectermBaseline, electermRoot } from './baseline.mjs';

const baseline = assertElectermBaseline();
const workApp = resolve(electermRoot, 'work/app');
const preload = resolve(import.meta.dirname, 'electerm-reference-preload.cjs');
if (!existsSync(workApp))
  throw new Error('Pinned Electerm is not built. Run bun run parity:prepare:electerm first.');
const referenceTemp = mkdtempSync(resolve(tmpdir(), 'axterm-electerm-reference-'));
const require = createRequire(resolve(electermRoot, 'package.json'));
const executablePath = require('electron');
const args = [
  resolve(workApp, 'app.js'),
  `--user-data-dir=${referenceTemp}`,
  '--disable-gpu',
  ...process.argv.slice(2),
];

console.log(
  `Launching Electerm ${baseline.packageVersion} at ${baseline.commit.slice(0, 12)} for comparison.`,
);
const child = spawn(executablePath, args, {
  cwd: electermRoot,
  env: {
    ...process.env,
    AXTERM_ELECTERM_PARITY: '1',
    NODE_TEST: 'yes',
    USERPROFILE: referenceTemp,
    XDG_CONFIG_HOME: resolve(referenceTemp, 'config'),
    XDG_DATA_HOME: resolve(referenceTemp, 'data'),
    XDG_CACHE_HOME: resolve(referenceTemp, 'cache'),
    TMPDIR: referenceTemp,
    NODE_OPTIONS: `--require=${preload}`,
  },
  stdio: 'inherit',
});

function cleanup() {
  rmSync(referenceTemp, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  cleanup();
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
