import { execFileSync } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertElectermBaseline, electermRoot } from './baseline.mjs';

function run(command, args, cwd = electermRoot) {
  execFileSync(command, args, {
    cwd,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    stdio: 'inherit',
  });
}

async function main() {
  const baseline = assertElectermBaseline();
  run('npm', ['install', '--no-package-lock', '--legacy-peer-deps', '--no-audit', '--no-fund']);
  run('npm', ['run', 'clean']);
  run('npm', ['run', 'compile']);

  const workApp = resolve(electermRoot, 'work/app');
  await cp(resolve(electermRoot, 'src/app'), workApp, { recursive: true, force: true });
  for (const file of ['user-config.json', 'localstorage.json', 'nohup.out'])
    await rm(resolve(workApp, file), { force: true });

  const packageJson = JSON.parse(await readFile(resolve(electermRoot, 'package.json'), 'utf8'));
  packageJson.main = 'app.js';
  for (const field of ['scripts', 'standard', 'files', 'engines', 'preferGlobal'])
    delete packageJson[field];
  if (process.platform === 'win32') delete packageJson.dependencies?.['node-bash'];
  else delete packageJson.dependencies?.['node-powershell'];
  await writeFile(resolve(workApp, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  run(
    'npm',
    ['install', '--omit=dev', '--no-package-lock', '--legacy-peer-deps', '--no-audit', '--no-fund'],
    workApp,
  );

  const require = createRequire(resolve(electermRoot, 'package.json'));
  const executable = require('electron');
  console.log(
    `Prepared Electerm ${baseline.packageVersion} at ${baseline.commit.slice(0, 12)}: ${executable}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
