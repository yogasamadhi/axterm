import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cruise } from 'dependency-cruiser';
import {
  inspectCredentialScript,
  inspectRendererCopy,
  inspectSource,
  isSystemCredentialModule,
} from './architecture-policy.mjs';

const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs');
const packageNames = ['runtime', 'contracts', 'client', 'db-schema', 'shared'];
const { output } = await cruise(
  ['apps/desktop/src', ...packageNames.map((name) => `packages/${name}/src`)],
  {
    ...config.options,
    ruleSet: config,
    validate: true,
    outputType: 'json',
  },
);
const graph = typeof output === 'string' ? JSON.parse(output) : output;
let failed = graph.summary.error > 0;
for (const violation of graph.summary.violations) {
  console.error(`${violation.rule.name}: ${violation.from} -> ${violation.to}`);
}
console.info(
  `Checked ${graph.summary.totalCruised} modules and ${graph.summary.totalDependenciesCruised} dependencies.`,
);
async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', 'dist', 'generated'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(path) && !path.endsWith('.test.ts')) {
      for (const error of inspectSource(path, await readFile(path, 'utf8'))) {
        console.error(error);
        failed = true;
      }
    } else if (
      path.includes('/renderer/') &&
      /\.(?:html|json)$/.test(path) &&
      !path.endsWith('package.json')
    ) {
      for (const error of inspectRendererCopy(path, await readFile(path, 'utf8'))) {
        console.error(error);
        failed = true;
      }
    }
  }
}
await scan('apps/desktop/src');
for (const name of packageNames) await scan(`packages/${name}/src`);

async function scanCredentialScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scanCredentialScripts(path);
    else if (/\.(?:[cm]?js|sh|ya?ml)$/.test(path)) {
      if (
        path === 'scripts/architecture-policy.mjs' ||
        path === 'scripts/parity/electerm-reference-preload.cjs'
      )
        continue;
      for (const error of inspectCredentialScript(path, await readFile(path, 'utf8'))) {
        console.error(error);
        failed = true;
      }
    }
  }
}

await scanCredentialScripts('scripts');
await scanCredentialScripts('.github');

for (const manifestPath of [
  'package.json',
  'apps/desktop/package.json',
  ...packageNames.map((name) => `packages/${name}/package.json`),
]) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (!isSystemCredentialModule(dependency)) continue;
      console.error(
        `${manifestPath}: System credential-store dependency ${dependency} is forbidden; use the application-local vault`,
      );
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.info('Architecture gate passed: Level 1 / Zero Business IPC.');
