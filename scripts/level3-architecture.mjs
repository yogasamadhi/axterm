import { readFile, readdir } from 'node:fs/promises';
import { existsSync, globSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { checkStyleOwnership } from './level3-style-check.mjs';
import { frameworkNames } from './dsh-framework.mjs';
import { isSystemCredentialModule } from './architecture-policy.mjs';

export const allowedFrameworkPackages = new Set(
  frameworkNames.map((name) =>
    ['cordis', 'cosmokit', 'schemastery'].includes(name)
      ? `@deepseek-ai/${name}`
      : `@deepseek-ai/cordis-plugin-${name}`,
  ),
);
export const publicContractPackages = new Set([
  '@axterm/plugin-api',
  '@axterm/engine-api',
  '@axterm/ui',
  '@axterm/remote-generator',
]);
// ADR-027/066/236: only the fixed-source core entry may import these reviewed vendor files.
// build-pi-engine verifies the independent source manifest before compiling them.
const pinnedPiSourceImports = new Set([
  '../../../vendor/pi/packages/schema/src/index.ts',
  '../../../vendor/pi/packages/agent/src/agent-loop.ts',
  '../../../vendor/pi/packages/ai/src/utils/estimate.ts',
  '../../../vendor/pi-auto-review/src/policy.ts',
  '../../../vendor/pi/packages/agent/src/types.ts',
  '../../../vendor/pi/packages/ai/src/types.ts',
  '../../../vendor/pi/packages/ai/src/providers/all.ts',
  '../../../vendor/pi/packages/ai/src/api/openai-completions.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/openai-responses.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/azure-openai-responses.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/anthropic-messages.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/google-generative-ai.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/mistral-conversations.lazy.ts',
  '../../../vendor/pi/packages/ai/src/api/pi-messages.lazy.ts',
]);
function pinnedPiSourceImport(filename, specifier, manifest) {
  return (
    manifest.name === '@axterm/engine-pi-core' &&
    resolve(filename).replaceAll('\\', '/').endsWith('/packages/pi-engine/src/index.ts') &&
    pinnedPiSourceImports.has(specifier)
  );
}
const bareName = (value) =>
  value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0];
const aiProviderSdks = new Set([
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  '@mistralai/mistralai',
]);
function selectedAiCoreImport(filename, node) {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.moduleSpecifier.text !== '@axterm/engine-pi-core' ||
    node.importClause?.name ||
    !node.importClause?.namedBindings ||
    !ts.isNamedImports(node.importClause.namedBindings)
  )
    return false;
  const path = resolve(filename).replaceAll('\\', '/');
  const symbols = path.endsWith('/packages/plugins/ai/src/adapters/pi-metadata.ts')
    ? new Set(['piCatalog', 'piSkills'])
    : path.endsWith('/packages/plugins/ai/src/adapters/command-review.ts')
      ? new Set([
          'buildClassifierTranscript',
          'commandExpansionLimitExceeded',
          'deterministicHardDeny',
          'parseDecision',
          'estimateReviewTextTokens',
        ])
      : new Set();
  return (
    node.importClause.namedBindings.elements.length > 0 &&
    node.importClause.namedBindings.elements.every((element) =>
      symbols.has((element.propertyName ?? element.name).text),
    )
  );
}
function selectedAiDiscoveryImport(filename, node) {
  return (
    resolve(filename)
      .replaceAll('\\', '/')
      .endsWith('/packages/plugins/ai/src/adapters/model-discovery.ts') &&
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    node.moduleSpecifier.text === '@axterm/engine-pi/discovery' &&
    !node.importClause?.name &&
    node.importClause?.namedBindings &&
    ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.length === 1 &&
    (
      node.importClause.namedBindings.elements[0].propertyName ??
      node.importClause.namedBindings.elements[0].name
    ).text === 'discoverLegacyModels'
  );
}

/** ADR-111: only named pure grammar/native-input types may enter their exact shell owners. */
function selectedDesktopInputContract(filename, node) {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.moduleSpecifier.text !== '@axterm/plugin-api/session-intents' ||
    node.importClause?.name ||
    !node.importClause?.namedBindings ||
    !ts.isNamedImports(node.importClause.namedBindings)
  )
    return false;
  const path = resolve(filename).replaceAll('\\', '/');
  const grammar =
    path.endsWith('/apps/desktop/src/shell/command-line.ts') ||
    path.endsWith('/apps/desktop/src/shell/launch-queue.ts');
  const inputType =
    path.endsWith('/apps/desktop/src/shell/launch-queue.ts') ||
    path.endsWith('/apps/desktop/src/shell/host-process.ts');
  return (
    node.importClause.namedBindings.elements.length > 0 &&
    node.importClause.namedBindings.elements.every((element) => {
      const symbol = (element.propertyName ?? element.name).text;
      return (
        (symbol === 'parseQuickConnect' && grammar) ||
        (symbol === 'DesktopLaunch' &&
          inputType &&
          (node.importClause.isTypeOnly || element.isTypeOnly))
      );
    })
  );
}

// Web only seeds a shared module identity; it must never call or destructure the root API.
function selectedReactSeedImport(filename, manifest, node, tree) {
  if (
    manifest.name !== '@axterm/web' ||
    !filename.replaceAll('\\', '/').endsWith('/apps/web/src/seed.ts') ||
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    node.moduleSpecifier.text !== 'react-dom/client' ||
    !node.importClause?.namedBindings ||
    !ts.isNamespaceImport(node.importClause.namedBindings)
  )
    return false;
  const binding = node.importClause.namedBindings.name;
  let exports = 0,
    invalid = false;
  function scan(value) {
    if (ts.isIdentifier(value) && value.text === binding.text && value !== binding) {
      const parent = value.parent;
      if (
        ts.isPropertyAssignment(parent) &&
        parent.initializer === value &&
        ts.isStringLiteral(parent.name) &&
        parent.name.text === 'react-dom/client'
      ) {
        let owner = parent;
        while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
        if (owner?.name?.text === 'getStaticModules') exports++;
        else invalid = true;
      } else invalid = true;
    }
    ts.forEachChild(value, scan);
  }
  scan(tree);
  return exports === 1 && !invalid;
}
export function inspectLevel3Source(filename, source, manifest, face = 'host') {
  const errors = [];
  const shell =
    face === 'shell' &&
    manifest.name === '@axterm/desktop' &&
    /\/apps\/desktop\/(?:src\/shell\/[^/]+\.ts|package\.json)$/.test(
      resolve(filename).replaceAll('\\', '/'),
    );
  if (face === 'shell' && !shell) errors.push('Desktop shell role requires its exact source owner');
  const preload = shell && filename.replaceAll('\\', '/').endsWith('/shell/preload.ts');
  const infrastructure =
    manifest.name.startsWith('@axterm/infra-') || publicContractPackages.has(manifest.name);
  const declared = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
      (field) => Object.keys(manifest[field] ?? {}),
    ),
  );
  const publicPackage = publicContractPackages.has(manifest.name);
  const application =
    manifest.name.startsWith('@axterm/plugin-') &&
    !publicPackage &&
    /\/src\/(application|domain)\//.test(resolve(filename).replaceAll('\\', '/')) &&
    !filename.endsWith('.test.ts');
  const nativeIo = new Set([
    'node:fs',
    'fs',
    'node:fs/promises',
    'fs/promises',
    'node:child_process',
    'child_process',
    'node:http',
    'http',
    'node:https',
    'https',
    'node:net',
    'net',
    'node:tls',
    'tls',
    'node:dgram',
    'dgram',
    'node:sqlite',
    'hono',
    'drizzle-orm',
    'ssh2',
    'node-pty',
    '@openclaw/fs-safe',
  ]);
  function inspectUiDependency(name) {
    if (!manifest.name.startsWith('@axterm/')) return;
    if (
      name === 'radix-ui' ||
      name.startsWith('@radix-ui/') ||
      name === 'class-variance-authority'
    ) {
      if (manifest.name !== '@axterm/ui')
        errors.push(`Shared UI primitives require the public controls owner: ${name}`);
    }
    if (
      name === '@base-ui/react' ||
      name === 'tailwind-merge' ||
      name === 'tailwindcss' ||
      name.startsWith('@tailwindcss/')
    )
      errors.push(`Retired UI stack is forbidden in Level 3 packages: ${name}`);
  }
  function inspect(
    specifier,
    typeOnly = false,
    selectedAiCore = false,
    selectedAiDiscovery = false,
    selectedDesktopInput = false,
    selectedUiSeed = false,
  ) {
    if (
      manifest.name === '@axterm/infra-connection' &&
      filename.replaceAll('\\', '/').endsWith('/src/document-security.ts') &&
      !new Set(['node:crypto', 'parse5']).has(specifier)
    )
      errors.push(`Document security must remain a pure policy helper: ${specifier}`);
    if (
      manifest.name === '@axterm/infra-profile-recovery' &&
      !specifier.startsWith('.') &&
      !new Set([
        'node:fs',
        'node:fs/promises',
        'node:crypto',
        'node:path',
        '@axterm/infra-atomic-write',
      ]).has(specifier)
    )
      errors.push(`Profile recovery is filesystem-only: ${specifier}`);
    if (
      manifest.name === '@axterm/plugin-ai' &&
      ((bareName(specifier) === '@axterm/engine-pi-core' && !selectedAiCore) ||
        (bareName(specifier) === '@axterm/engine-pi' && !selectedAiDiscovery) ||
        aiProviderSdks.has(bareName(specifier)))
    )
      errors.push(
        'AI Agent/API execution must use ctx.engines; only selected metadata and pure review policy imports are allowed',
      );
    if (
      specifier === 'node-pty' &&
      !typeOnly &&
      manifest.name.startsWith('@axterm/plugin-') &&
      !publicPackage
    )
      errors.push('Business plugins must acquire PTYs through ctx.subprocess');
    if (
      application &&
      !typeOnly &&
      (nativeIo.has(specifier) ||
        specifier.startsWith('@axterm/infra-') ||
        /(?:^|\/)adapters(?:\/|$)/.test(specifier))
    )
      errors.push(`Application/domain code must use its owned ports: ${specifier}`);
    if (
      preload &&
      specifier !== 'electron' &&
      !(typeOnly && specifier === '@axterm/web/bootstrap') &&
      specifier !== './directory-drop.ts' &&
      specifier !== '@axterm/plugin-api/shortcuts'
    )
      errors.push(`Desktop preload only permits the closed shell bridges: ${specifier}`);
    if (specifier.startsWith('.')) {
      if (shell && dirname(resolve(dirname(filename), specifier)) !== dirname(resolve(filename)))
        errors.push(`Desktop shell relative import escapes its role: ${specifier}`);
      const marker = `${sep}src${sep}`;
      const sourcePath = resolve(filename);
      const index = sourcePath.lastIndexOf(marker);
      if (index >= 0) {
        const packageRoot = sourcePath.slice(0, index);
        const suffix = relative(packageRoot, resolve(dirname(sourcePath), specifier));
        if (
          (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) &&
          !pinnedPiSourceImport(filename, specifier, manifest)
        )
          errors.push(`Relative import escapes package: ${specifier}`);
      }
      return;
    }
    if (specifier.startsWith('internal/')) {
      const ownedBinding =
        manifest.name === '@axterm/infra-hmr' &&
        filename.replaceAll('\\', '/').endsWith('/src/package-manifest.ts') &&
        specifier === 'internal/test/binding';
      if (face === 'client' || !ownedBinding)
        errors.push(`Node internal access is restricted to its Host owner: ${specifier}`);
      return;
    }
    if (isBuiltin(specifier)) {
      if (face === 'client') errors.push(`Client code cannot import native modules: ${specifier}`);
      if (
        publicPackage &&
        manifest.name !== '@axterm/remote-generator' &&
        !(typeOnly && filename.replaceAll('\\', '/').includes('/host/'))
      )
        errors.push(`Common public API cannot import native modules: ${specifier}`);
      return;
    }
    const name = bareName(specifier);
    if (
      specifier === 'react-dom/client' &&
      !typeOnly &&
      manifest.name !== '@axterm/infra-ui-renderer' &&
      !selectedUiSeed
    )
      errors.push('Only the owned UI renderer may mount a React root');
    inspectUiDependency(name);
    if (publicPackage && name.startsWith('@axterm/') && !publicContractPackages.has(name))
      errors.push(`Public API cannot import private packages: ${name}`);
    if (name.startsWith('@deepseek-ai/') && !allowedFrameworkPackages.has(name))
      errors.push(`DSH product dependency is forbidden: ${name}`);
    if ((name === 'electron' && !shell) || isSystemCredentialModule(name))
      errors.push(`Native shell dependency is forbidden: ${name}`);
    if (
      shell &&
      !selectedDesktopInput &&
      !(
        specifier === '@axterm/infra-connection/document-security' &&
        filename.replaceAll('\\', '/').endsWith('/shell/web-document.ts')
      ) &&
      !(
        specifier === '@axterm/plugin-api/shortcuts' &&
        /\/shell\/(?:keyboard|preload)\.ts$/.test(filename.replaceAll('\\', '/'))
      ) &&
      !new Set([
        'electron',
        '@axterm/infra-connection',
        '@axterm/infra-desktop-native',
        '@axterm/infra-credential-vault',
        '@axterm/infra-profile-recovery',
        '@axterm/desktop-host/protocol',
        '@axterm/web/bootstrap',
      ]).has(specifier)
    )
      errors.push(`Desktop shell cannot load business or execution packages: ${specifier}`);
    if (shell && specifier === '@axterm/web/bootstrap' && !typeOnly)
      errors.push('Desktop shell can only use Web bootstrap types');
    if (infrastructure && name.startsWith('@workspace/'))
      errors.push(`Infrastructure cannot import legacy application code: ${name}`);
    if (
      infrastructure &&
      name.startsWith('@axterm/') &&
      !name.startsWith('@axterm/infra-') &&
      !publicContractPackages.has(name)
    )
      errors.push(`Infrastructure cannot import application code: ${name}`);
    if (specifier.includes('/src/'))
      errors.push(`Cross-package source import is forbidden: ${specifier}`);
    if (name === manifest.name) {
      const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
      if (!Object.hasOwn(manifest.exports ?? {}, subpath))
        errors.push(`Package self-reference must use a declared export: ${specifier}`);
      if (face === 'client' && subpath === '.' && manifest.exports?.['./client'])
        errors.push(`Client program cannot load a paired package's Host entry`);
    } else if (!declared.has(name)) errors.push(`Undeclared package dependency: ${name}`);
  }
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      manifest.name === '@axterm/infra-profile-recovery' &&
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'getBuiltinModule'))
    ) {
      if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
        errors.push('Profile recovery dynamic resolution must name a filesystem capability');
      else inspect(node.arguments[0].text);
    }
    if (
      manifest.name === '@axterm/plugin-ai' &&
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
    )
      errors.push('AI dynamic dependency resolution must name a reviewed contract');
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      inspect(
        node.moduleSpecifier.text,
        ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly === true
          : node.isTypeOnly === true,
        selectedAiCoreImport(filename, node),
        selectedAiDiscoveryImport(filename, node),
        selectedDesktopInputContract(filename, node),
        selectedReactSeedImport(filename, manifest, node, tree),
      );
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      inspect(node.arguments[0].text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      inspect(node.argument.literal.text, true);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (
        manifest.name === '@axterm/infra-profile-recovery' &&
        name !== '@axterm/infra-atomic-write'
      )
        errors.push(`Profile recovery dependency is filesystem-only: ${name}`);
      if (manifest.name === '@axterm/plugin-ai' && aiProviderSdks.has(name))
        errors.push(`AI provider SDK dependency must remain behind ctx.engines: ${name}`);
      inspectUiDependency(name);
      if (publicPackage && name.startsWith('@axterm/') && !publicContractPackages.has(name))
        errors.push(`Public API cannot depend on private packages: ${name}`);
      if (name.startsWith('@deepseek-ai/') && !allowedFrameworkPackages.has(name))
        errors.push(`DSH product dependency is forbidden: ${name}`);
      if ((name === 'electron' && !shell) || isSystemCredentialModule(name))
        errors.push(`Native shell dependency is forbidden: ${name}`);
      if (infrastructure && name.startsWith('@workspace/'))
        errors.push(`Infrastructure cannot depend on legacy application code: ${name}`);
      if (
        infrastructure &&
        name.startsWith('@axterm/') &&
        !name.startsWith('@axterm/infra-') &&
        !publicContractPackages.has(name)
      )
        errors.push(`Infrastructure cannot depend on application code: ${name}`);
    }
  }
  return [...new Set(errors)].map((error) => `${filename}: ${error}`);
}

export function inspectClientSource(filename, source, manifest) {
  const errors = inspectLevel3Source(filename, source, manifest, 'client');
  if (manifest.exports?.['./client'] && filename.replaceAll('\\', '/').endsWith('/src/index.ts'))
    errors.push(`${filename}: Client program cannot load a paired package's Host entry`);
  return errors;
}

export function inspectClientConfiguration(config) {
  const errors = [];
  if (JSON.stringify(config.compilerOptions?.types) !== '[]')
    errors.push('Client program must explicitly exclude ambient Node types');
  for (const [name, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
    if (targets.some((target) => target.includes('/lib/') || target.includes('/src/host/')))
      errors.push(`Client source mapping cannot reach Host or build outputs: ${name}`);
  }
  return errors;
}

/** Check all reachable application sources, including shared modules outside src/client. */
export function inspectClientProgram(root, packages) {
  const file = join(root, 'tsconfig.client.json');
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error)
    throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
  if (config.errors.length)
    throw new Error(
      config.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  const errors = inspectClientConfiguration({ compilerOptions: config.options });
  const program = ts.createProgram(config.fileNames, config.options);
  for (const file of program.getSourceFiles()) {
    if (file.fileName.replaceAll('\\', '/').includes('/@types/node/'))
      errors.push(`Client program acquired ambient Node declarations: ${file.fileName}`);
    const owner = packages.find(({ directory }) => {
      const path = relative(join(root, directory, 'src'), file.fileName);
      return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    });
    if (owner) errors.push(...inspectClientSource(file.fileName, file.text, owner.manifest));
  }
  return [...new Set(errors)];
}

export function inspectSourceFirst(config, packages) {
  const errors = [];
  const paths = config.compilerOptions?.paths ?? {};
  for (const { name, directory } of packages) {
    const facade =
      name === '@axterm/engine-pi-core' && directory === 'packages/pi-engine'
        ? 'public.ts'
        : 'index.ts';
    const expected = `./${directory}/src/${facade}`;
    if (JSON.stringify(paths[name]) !== JSON.stringify([expected]))
      errors.push(`Source-first Host mapping required: ${name} -> ${expected}`);
  }
  for (const include of config.include ?? [])
    if (include.includes('/lib/') || include.includes('/client/'))
      errors.push(`Host source check cannot include generated or Client code: ${include}`);
  return errors;
}

export function inspectRemoteContributors(config, packages) {
  const references = new Set((config.references ?? []).map((row) => row.path.replace(/^\.\//, '')));
  const errors = [];
  for (const { directory, manifest, hostConfig } of packages) {
    if (manifest.exports?.['./typert'] && !references.has(`${directory}/${hostConfig}`))
      errors.push(`Remote contributor is absent from the Host aggregate: ${manifest.name}`);
  }
  return errors;
}

export async function checkLevel3Architecture(root = resolve(import.meta.dirname, '..')) {
  const errors = [];
  const packages = [];
  const sourcePackages = [];
  const ownedPackages = [];
  const manifests = globSync(
    ['packages/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json'],
    { cwd: root },
  ).sort();
  for (const file of manifests) {
    const manifest = JSON.parse(await readFile(join(root, file), 'utf8'));
    if (!manifest.name?.startsWith('@axterm/')) continue;
    const directory = dirname(file).replaceAll('\\', '/');
    packages.push(directory);
    ownedPackages.push({ directory, manifest });
    errors.push(
      ...inspectLevel3Source(
        join(directory, 'package.json'),
        '',
        manifest,
        directory === 'apps/desktop' ? 'shell' : 'host',
      ),
    );
    if (!existsSync(join(root, directory, 'src'))) continue;
    if (manifest.exports?.['.']) sourcePackages.push({ name: manifest.name, directory });
    async function scan(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (/\.tsx?$/u.test(path))
          errors.push(
            ...inspectLevel3Source(
              path,
              await readFile(path, 'utf8'),
              manifest,
              directory === 'apps/desktop' && path.replaceAll('\\', '/').includes('/src/shell/')
                ? 'shell'
                : path.replaceAll('\\', '/').includes('/src/client/')
                  ? 'client'
                  : 'host',
            ),
          );
      }
    }
    await scan(join(root, directory, 'src'));
  }
  const desktopManifest = JSON.parse(
    await readFile(join(root, 'apps/desktop/package.json'), 'utf8'),
  );
  if (
    desktopManifest.name !== '@axterm/desktop' ||
    desktopManifest.main !== 'lib/shell/main.js' ||
    typeof desktopManifest.axterm?.migrationValidation !== 'boolean'
  )
    errors.push(
      'Desktop manifest must declare the actual owned Shell entry and explicit migration policy',
    );
  for (const file of globSync('apps/desktop/src/shell/*.ts', { cwd: root }))
    errors.push(
      ...inspectLevel3Source(
        join(root, file),
        await readFile(join(root, file), 'utf8'),
        desktopManifest,
        'shell',
      ),
    );
  errors.push(
    ...inspectRemoteContributors(
      JSON.parse(await readFile(join(root, 'tsconfig.remote.host.json'), 'utf8')),
      ownedPackages.map((row) => ({
        ...row,
        hostConfig: existsSync(join(root, row.directory, 'tsconfig.host.json'))
          ? 'tsconfig.host.json'
          : 'tsconfig.json',
      })),
    ),
  );
  const hostConfig = JSON.parse(await readFile(join(root, 'tsconfig.host.json'), 'utf8'));
  errors.push(...inspectSourceFirst(hostConfig, sourcePackages));
  errors.push(...inspectClientProgram(root, ownedPackages));
  checkStyleOwnership(root);
  if (errors.length) throw new Error(errors.join('\n'));
  return packages.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.info(
    `Level 3 migration dependency gate passed: ${await checkLevel3Architecture()} application-owned packages; old Runtime gate remains active.`,
  );
}
