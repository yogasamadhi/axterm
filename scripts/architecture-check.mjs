import { checkSourceBoundaries } from './source-boundaries.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { globSync, existsSync } from 'node:fs';
import { cruise } from 'dependency-cruiser';
import { checkLevel3Architecture } from './level3-architecture.mjs';
import {
  inspectCredentialScript,
  inspectRendererCopy,
  inspectSource,
  isSystemCredentialModule,
} from './architecture-policy.mjs';

await checkSourceBoundaries(process.cwd());
const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs');
const roots = [...globSync(['apps/*/src', 'packages/*/src', 'packages/*/*/src'])]
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => !path.startsWith('packages/framework/'))
  .sort();
if (!roots.length) throw new Error('No application source roots were discovered');
let failed = false;
// Type-only imports retain all ownership/native/unresolved checks. Erased edges do not form runtime cycles.
for (const runtime of [false, true]) {
  const rules = config.forbidden.filter((rule) => (rule.name === 'no-circular') === runtime);
  const { output } = await cruise(roots, {
    ...config.options,
    tsPreCompilationDeps: !runtime,
    ruleSet: { ...config, forbidden: rules },
    validate: true,
    outputType: 'json',
  });
  const graph = typeof output === 'string' ? JSON.parse(output) : output;
  failed ||= graph.summary.error > 0;
  for (const violation of graph.summary.violations)
    console.error(`${violation.rule.name}: ${violation.from} -> ${violation.to}`);
  console.info(
    `Checked ${runtime ? 'runtime' : 'source/type'} graph: ${graph.summary.totalCruised} modules and ${graph.summary.totalDependenciesCruised} dependencies.`,
  );
}
async function scan(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', 'dist', 'generated', 'lib'].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(path) && !/\.(?:test|spec|d)\.tsx?$/.test(path)) {
      for (const error of inspectSource(path, await readFile(path, 'utf8'))) {
        console.error(error);
        failed = true;
      }
    } else if (
      (path.includes('/renderer/') ||
        path.includes('/src/client/') ||
        path.startsWith('apps/web/src/')) &&
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
for (const path of roots) await scan(path);

async function scanCredentialScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scanCredentialScripts(path);
    else if (/\.(?:[cm]?js|sh|ya?ml)$/.test(path)) {
      if (path === 'scripts/architecture-policy.mjs') continue;
      for (const error of inspectCredentialScript(path, await readFile(path, 'utf8'))) {
        console.error(error);
        failed = true;
      }
    }
  }
}

for (const path of ['scripts', '.github']) if (existsSync(path)) await scanCredentialScripts(path);

for (const manifestPath of [
  'package.json',
  ...globSync(['apps/*/package.json', 'packages/*/package.json', 'packages/*/*/package.json']),
].filter(existsSync)) {
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
if (existsSync('tsconfig.host.json') && existsSync('tsconfig.client.json')) {
  try {
    console.info(
      `Checked ${await checkLevel3Architecture(process.cwd())} owned Host/Client packages.`,
    );
  } catch (error) {
    console.error(error.message);
    failed = true;
  }
}
if (failed) process.exit(1);
console.info(
  'Architecture gate passed: owned runtime/type boundaries, zero business IPC and local Vault.',
);
