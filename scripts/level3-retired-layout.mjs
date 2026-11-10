import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const retiredProductionPaths = [
  ...['runtime', 'client', 'contracts', 'shared', 'db-schema'].map(
    (name) => `packages/${name}/package.json`,
  ),
  ...['main', 'preload', 'renderer'].map((name) => `apps/desktop/src/${name}`),
  'apps/desktop/electron.vite.config.ts',
  'apps/desktop/tsconfig.node.json',
  'apps/desktop/tsconfig.web.json',
  'scripts/contracts.ts',
  'scripts/run-ts.mjs',
];
/** Historical fixtures and source-attribution comments are data, never runtime admission paths. */
export function inspectRetiredEngineering({
  rootPackage,
  desktopPackage,
  typeConfig,
  workflow,
  present = /** @type {string[]} */ ([]),
}) {
  const errors = [];
  for (const path of present)
    if (retiredProductionPaths.includes(path))
      errors.push(`Retired production entry remains: ${path}`);
  if (
    desktopPackage.name !== '@axterm/desktop' ||
    desktopPackage.main !== 'lib/shell/main.js' ||
    typeof desktopPackage.axterm?.migrationValidation !== 'boolean'
  )
    errors.push('Desktop must start its owned Shell');
  for (const name of ['openapi:generate', 'client:generate'])
    if (rootPackage.scripts?.[name]) errors.push('Retired OpenAPI generator remains');
  const old =
    /@workspace\/(?:runtime|client|contracts|shared|db-schema|desktop)\b|apps\/desktop\/src\/(?:main|preload|renderer)\b|packages\/(?:runtime|client|contracts|shared|db-schema)\/(?:src|package\.json)\b|electron-vite/u;
  for (const [owner, value] of [
    ['root commands', rootPackage.scripts],
    ['desktop manifest', desktopPackage],
    ['type aliases', typeConfig.compilerOptions?.paths],
    ['CI workflow', workflow],
  ])
    if (old.test(JSON.stringify(value)))
      errors.push(`${owner} still selects a retired implementation`);
  const allowed = new Set([
    '@axterm/web',
    '@axterm/desktop-host',
    '@axterm/infra-connection',
    '@axterm/infra-desktop-native',
    '@axterm/infra-credential-vault',
    '@axterm/infra-profile-recovery',
    '@axterm/plugin-api',
  ]);
  for (const name of Object.keys(desktopPackage.dependencies ?? {}))
    if (!allowed.has(name)) errors.push(`Desktop dependency is not Shell-owned: ${name}`);
  return errors;
}
export function checkRetiredEngineering(root = resolve(import.meta.dirname, '..')) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const errors = inspectRetiredEngineering({
    rootPackage: json('package.json'),
    desktopPackage: json('apps/desktop/package.json'),
    typeConfig: json('tsconfig.json'),
    workflow: readFileSync(join(root, '.github/workflows/check.yml'), 'utf8'),
    present: retiredProductionPaths.filter((path) => existsSync(join(root, path))),
  });
  const paths = globSync(
    [
      'apps/*/src/**/*.{ts,tsx}',
      'packages/{api,infra,plugins,engines,data,bundles}/*/src/**/*.{ts,tsx}',
    ],
    { cwd: root },
  );
  for (const path of paths) {
    const source = readFileSync(join(root, path), 'utf8');
    if (/['"`]\/api\/v1(?:\/|['"`])/u.test(source))
      errors.push(`${path}: retired business REST endpoint`);
  }
  if (!paths.length) errors.push('No actual owned production sources were inspected');
  if (errors.length) throw Error(errors.join('\n'));
  return { sourceFiles: paths.length, retiredEntries: retiredProductionPaths.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log('Retired production layout:', checkRetiredEngineering());
