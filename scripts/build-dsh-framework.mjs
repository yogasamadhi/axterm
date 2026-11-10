import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'tsdown';
import { frameworkNames, prepareFramework } from './dsh-framework.mjs';

const root = resolve(import.meta.dirname, '..');
await prepareFramework(root);
// These compilation settings preserve the pinned framework's policy without depending
// on the upstream product's workspace aliases or root build configuration.
const upstreamBase = {
  target: 'es2024',
  module: 'esnext',
  moduleResolution: 'bundler',
  declaration: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: false,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  types: ['node'],
};
for (const name of frameworkNames) {
  const directory = join(root, 'packages/framework', name);
  await rm(join(directory, 'lib'), { recursive: true, force: true });
  const upstream = JSON.parse(
    await readFile(join(root, 'vendor/deepseek-harness/vendor', name, 'tsconfig.json'), 'utf8'),
  );
  const base = { ...upstreamBase };
  const compilerOptions = {
    ...base,
    ...upstream.compilerOptions,
    composite: false,
    incremental: false,
    emitDeclarationOnly: false,
    declarationMap: false,
    sourceMap: false,
  };
  await writeFile(
    join(directory, 'tsconfig.generated.json'),
    JSON.stringify({ compilerOptions, include: ['src'] }, null, 2),
  );
  const declarations = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(directory, 'tsconfig.generated.json'),
    ],
    { stdio: 'inherit' },
  );
  if (declarations.status !== 0) throw new Error(`Framework declarations failed: ${name}`);
  const entry = Object.fromEntries(
    (name === 'logger-console' ? ['index', 'browser'] : ['index']).map((entry) => [
      entry,
      join(directory, 'lib/types', `${entry}.js`),
    ]),
  );
  await build({
    entry,
    outDir: join(directory, 'lib'),
    format: name === 'schemastery' ? ['esm', 'cjs'] : ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    deps: { neverBundle: [/^[^./]/] },
    logLevel: 'warn',
    ...(name === 'schemastery'
      ? { outExtensions: ({ format }) => ({ js: format === 'es' ? '.mjs' : '.cjs' }) }
      : {}),
  });
}
console.info(`Built ${frameworkNames.length} unmodified Cordis framework packages.`);
