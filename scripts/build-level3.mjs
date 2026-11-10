import { readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'tsdown';
import { ownedClientCss } from './client-css.mjs';
import { buildClientBundle } from './client-bundle.mjs';
import { assertProfileBundleDependencies } from './profile-dependency-check.mjs';

const root = resolve(import.meta.dirname, '..');
const packages = [
  'api/plugin-api',
  'api/engine-api',
  'api/ui',
  'tooling/remote-generator',
  'data/schema',
  'engines/pi',
  ...[
    'credentials',
    'scope',
    'engines',
    'typert-registry',
    'deque',
    'timeout',
    'web-server',
    'connection',
    'atomic-write',
    'credential-vault',
    'desktop-native',
    'storage',
    'storage-domain',
    'storage-sqlite',
    'storage-relational',
    'package-manifest',
    'client-modules',
    'client-hmr',
    'ui-renderer',
    'locale',
    'shortcuts',
    'ui-theme',
    'frontend-static',
    'home-paths',
    'launch-environment',
    'cmdline',
    'http-proxy',
    'lazy-require',
    'win32-process',
    'subprocess',
    'subprocess-local',
    'profile-recovery',
    'app-boot',
    'web-startup',
    'typert-loader',
    'remote-access',
    'gateway',
    'hmr',
    'plugin-manager',
  ].map((name) => `infra/${name}`),
];
const businessPackages = [
  'ai',
  'desktop',
  'terminals',
  'catalog',
  'configuration',
  'connections',
  'files',
  'transfers',
  'remote-desktop',
  'automation',
  'workspace',
  'plugins',
  'market',
];

// Clean the entire dependency closure before compiling any package: a stale future
// artifact must never hide an incorrect build order in a warm working tree.
for (const packagePath of packages)
  await rm(join(root, 'packages', packagePath, 'lib'), { recursive: true, force: true });
for (const packagePath of packages) {
  const name = packagePath.split('/').at(-1);
  const directory = join(root, 'packages', packagePath);
  for (const face of [
    'ui',
    'typert-registry',
    'connection',
    'gateway',
    'client-modules',
    'client-hmr',
    'ui-renderer',
    'locale',
    'shortcuts',
    'ui-theme',
  ].includes(name)
    ? ['host', 'client']
    : [['plugin-api', 'engine-api', 'ui'].includes(name) ? 'host' : null]) {
    const config = JSON.parse(
      await readFile(
        join(directory, face === null ? 'tsconfig.json' : `tsconfig.${face}.json`),
        'utf8',
      ),
    );
    config.compilerOptions = {
      ...config.compilerOptions,
      paths: {},
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: false,
      rewriteRelativeImportExtensions: true,
      rootDir: 'src',
      outDir: 'lib/types',
    };
    await writeFile(join(directory, 'tsconfig.generated.json'), JSON.stringify(config, null, 2));
    const types = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(directory, 'tsconfig.generated.json'),
      ],
      { stdio: 'inherit' },
    );
    if (types.status !== 0) throw new Error(`Strict infrastructure declarations failed: ${name}`);
  }
  const entry = { index: join(directory, 'lib/types/index.js') };
  if (name === 'app-boot')
    entry['worker/profile-resolution-bootstrap'] = join(
      directory,
      'lib/types/profile-resolution/worker-bootstrap.js',
    );
  if (
    [
      'typert-registry',
      'connection',
      'gateway',
      'client-modules',
      'client-hmr',
      'ui-renderer',
      'locale',
      'shortcuts',
      'ui-theme',
    ].includes(name)
  ) {
    entry.client = join(directory, 'lib/types/client/index.js');
  }
  if (['typert-registry', 'remote-access', 'gateway'].includes(name)) {
    entry.types = join(directory, 'lib/types/types.js');
  }
  if (packagePath === 'engines/pi') entry.discovery = join(directory, 'lib/types/discovery.js');
  if (name === 'storage-relational') entry.copy = join(directory, 'lib/types/copy.js');
  if (name === 'connection')
    entry['document-security'] = join(directory, 'lib/types/document-security.js');
  if (name === 'gateway') entry.events = join(directory, 'lib/types/events.js');
  if (name === 'ui') {
    entry['store-contract'] = join(directory, 'lib/types/store-contract.js');
    entry.workspace = join(directory, 'lib/types/workspace.js');
    entry.presentation = join(directory, 'lib/types/presentation.js');
    entry.preference = join(directory, 'lib/types/preference.js');
    entry.shortcuts = join(directory, 'lib/types/shortcuts.js');
    entry.controls = join(directory, 'lib/types/client/controls.js');
  }
  if (name === 'desktop-native') {
    entry.credentials = join(directory, 'lib/types/credentials.js');
    entry.files = join(directory, 'lib/types/file-grants.js');
    entry.applications = join(directory, 'lib/types/applications.js');
    entry['local-files'] = join(directory, 'lib/types/local-files.js');
  }
  if (name === 'web-server') entry.types = join(directory, 'lib/types/types.js');
  if (name === 'credentials') entry.types = join(directory, 'lib/types/types.js');
  if (name === 'engine-api') entry.host = join(directory, 'lib/types/host/index.js');
  if (name === 'subprocess') entry.control = join(directory, 'lib/types/control.js');
  if (name === 'subprocess-local') {
    entry.runner = join(directory, 'lib/types/bin.js');
    entry.output = join(directory, 'lib/types/output.js');
  }
  if (name === 'plugin-api') {
    entry.brand = join(directory, 'lib/types/brand.js');
    entry.credentials = join(directory, 'lib/types/credentials.js');
    entry['saved-credentials'] = join(directory, 'lib/types/saved-credentials.js');
    entry.types = join(directory, 'lib/types/types.js');
    entry['remote-info'] = join(directory, 'lib/types/remote-info.js');
    entry.host = join(directory, 'lib/types/host/index.js');
    entry.desktop = join(directory, 'lib/types/desktop.js');
    entry['session-intents'] = join(directory, 'lib/types/session-intents.js');
    entry.terminals = join(directory, 'lib/types/terminals.js');
    entry.catalog = join(directory, 'lib/types/catalog.js');
    entry.configuration = join(directory, 'lib/types/configuration.js');
    entry.shortcuts = join(directory, 'lib/types/shortcuts.js');
    entry['configuration-portable'] = join(directory, 'lib/types/configuration-portable.js');
    entry['configuration-sync'] = join(directory, 'lib/types/configuration-sync.js');
    entry.ai = join(directory, 'lib/types/ai.js');
    entry.plugins = join(directory, 'lib/types/plugins.js');
    entry.market = join(directory, 'lib/types/market.js');
    entry.subprocess = join(directory, 'lib/types/subprocess.js');
    entry.connections = join(directory, 'lib/types/connections.js');
    entry.files = join(directory, 'lib/types/files.js');
    entry.transfers = join(directory, 'lib/types/transfers.js');
    entry['remote-desktop'] = join(directory, 'lib/types/remote-desktop.js');
    entry.automation = join(directory, 'lib/types/automation.js');
    entry.storage = join(directory, 'lib/types/storage.js');
    entry['stream-protocol'] = join(directory, 'lib/types/stream-protocol.js');
  }
  await build({
    entry,
    plugins: [ownedClientCss(directory)],
    outDir: join(directory, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    deps: { neverBundle: [/^(?!\0)[^./]/] },
    logLevel: 'warn',
  });
  if (name === 'ui-theme')
    await copyFile(
      join(directory, 'src/client/bootstrap.module.css'),
      join(directory, 'lib/bootstrap.module.css'),
    );
}
console.info(`Built ${packages.length} strict application-owned SDK/infrastructure packages.`);

// Business Host faces compile before their generated Client contracts.
for (const name of businessPackages) {
  const directory = join(root, 'packages/plugins', name);
  await rm(join(directory, 'lib'), { recursive: true, force: true });
  if (name === 'configuration') {
    const { buildLegalDocuments } =
      await import('../packages/plugins/configuration/build-legal-documents.mjs');
    await buildLegalDocuments(directory);
  }
  if (name === 'remote-desktop') {
    const { buildRemoteDesktopAssets } =
      await import('../packages/plugins/remote-desktop/build-client-assets.mjs');
    await buildRemoteDesktopAssets(directory);
  }
  const config = JSON.parse(await readFile(join(directory, 'tsconfig.host.json'), 'utf8'));
  config.compilerOptions = {
    ...config.compilerOptions,
    paths: {},
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: false,
    rewriteRelativeImportExtensions: true,
    rootDir: 'src',
    outDir: 'lib/types',
  };
  await writeFile(join(directory, 'tsconfig.generated.json'), JSON.stringify(config, null, 2));
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(directory, 'tsconfig.generated.json'),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`Strict domain build failed: ${name}`);
  await build({
    entry: {
      index: join(directory, 'lib/types/index.js'),
      ...([
        'catalog',
        'configuration',
        'ai',
        'automation',
        'transfers',
        'desktop',
        'terminals',
      ].includes(name)
        ? { copy: join(directory, 'lib/types/copy.js') }
        : {}),
      ...(name === 'terminals' ? { facts: join(directory, 'lib/types/facts.js') } : {}),
      ...(name === 'desktop'
        ? {
            headless: join(directory, 'lib/types/headless.js'),
            tasks: join(directory, 'lib/types/tasks.js'),
          }
        : {}),
    },
    outDir: join(directory, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    deps: { neverBundle: [/^(?!\0)[^./]/] },
    logLevel: 'warn',
  });
}
const { WorkspaceTypertGenerator, writeWorkspaceArtifacts } =
  await import('../packages/tooling/remote-generator/lib/index.js');
const generated = new WorkspaceTypertGenerator(root, {
  hostConfig: 'tsconfig.remote.host.json',
}).generateContributors(['host']);
writeWorkspaceArtifacts(root, generated);
console.info(`Generated ${generated.length} application Remote contributions.`);

for (const name of businessPackages) {
  const directory = join(root, 'packages/plugins', name);
  const config = JSON.parse(await readFile(join(directory, 'tsconfig.client.json'), 'utf8'));
  config.compilerOptions = {
    ...config.compilerOptions,
    paths: {},
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: false,
    rewriteRelativeImportExtensions: true,
    rootDir: 'src',
    outDir: 'lib/types',
  };
  await writeFile(join(directory, 'tsconfig.generated.json'), JSON.stringify(config, null, 2));
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(directory, 'tsconfig.generated.json'),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`Strict Client model build failed: ${name}`);
  await build({
    entry: { client: join(directory, 'lib/types/client/index.js') },
    plugins: [ownedClientCss(directory)],
    outDir: join(directory, 'lib'),
    format: ['esm'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: directory,
    deps: { neverBundle: [/^(?!\0)[^./]/] },
    logLevel: 'warn',
  });
}

// The shell consumes the carrier's pure startup contract without importing its browser entry.
const webPackage = join(root, 'apps/web');
await rm(join(webPackage, 'lib'), { recursive: true, force: true });
const webConfig = JSON.parse(await readFile(join(webPackage, 'tsconfig.json'), 'utf8'));
webConfig.compilerOptions = {
  ...webConfig.compilerOptions,
  paths: {},
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: false,
  rewriteRelativeImportExtensions: true,
  rootDir: 'src',
  outDir: 'lib/types',
};
await writeFile(join(webPackage, 'tsconfig.generated.json'), JSON.stringify(webConfig, null, 2));
const webTypes = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(webPackage, 'tsconfig.generated.json'),
  ],
  { stdio: 'inherit' },
);
if (webTypes.status !== 0) throw new Error('Strict Web carrier declarations failed');

for (const application of ['cli', 'desktop-host']) {
  const cli = join(root, 'apps', application);
  await rm(join(cli, 'lib'), { recursive: true, force: true });
  const config = JSON.parse(await readFile(join(cli, 'tsconfig.json'), 'utf8'));
  config.compilerOptions = {
    ...config.compilerOptions,
    paths: {},
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: false,
    rewriteRelativeImportExtensions: true,
    rootDir: 'src',
    outDir: 'lib/types',
  };
  await writeFile(join(cli, 'tsconfig.generated.json'), JSON.stringify(config, null, 2));
  const declarations = spawnSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(cli, 'tsconfig.generated.json')],
    { stdio: 'inherit' },
  );
  if (declarations.status !== 0) throw new Error('Strict Profile runner declarations failed');
  await build({
    entry: {
      index: join(cli, 'lib/types/index.js'),
      ...(application === 'cli'
        ? {
            'profile-boot': join(cli, 'lib/types/profile-boot.js'),
            'profile-templates': join(cli, 'lib/types/profile-templates.js'),
          }
        : {
            protocol: join(cli, 'lib/types/protocol.js'),
            copy: join(cli, 'lib/types/copy/home.js'),
          }),
    },
    outDir: join(cli, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    clean: false,
    dts: false,
    exports: false,
    config: false,
    tsconfig: false,
    cwd: cli,
    deps: { neverBundle: [/^(?!\0)[^./]/] },
    logLevel: 'warn',
  });
}

// Verify the actual production resolution anchors, not source-hoisted availability.
const { PROFILE_TEMPLATES } = await import(
  pathToFileURL(join(root, 'apps/cli/lib/profile-templates.js')).href
);
assertProfileBundleDependencies(
  JSON.parse(await readFile(join(root, 'apps/cli/package.json'), 'utf8')),
  PROFILE_TEMPLATES,
);
assertProfileBundleDependencies(
  JSON.parse(await readFile(join(root, 'apps/desktop-host/package.json'), 'utf8')),
  PROFILE_TEMPLATES,
  ['desktop'],
);

// Every declared Client entry must have its independently loadable browser factory.
// Derive this from package metadata so a new domain cannot silently miss distribution.
for (const relative of [...packages, ...businessPackages.map((name) => `plugins/${name}`)]) {
  const directory = join(root, 'packages', relative);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.axterm?.client?.platform === 'web') await buildClientBundle(directory);
}

const webDirectory = join(root, 'apps/web');
const webRequire = createRequire(join(webDirectory, 'package.json'));
const vite = await import(
  pathToFileURL(join(dirname(webRequire.resolve('vite/package.json')), 'dist/node/index.js')).href
);
await vite.build({ configFile: join(webDirectory, 'vite.config.mjs'), logLevel: 'warn' });
console.info('Built the application Web carrier and authenticated connection page.');

const { buildLevel3Shell } = await import('./build-level3-shell.mjs');
await buildLevel3Shell(root);
