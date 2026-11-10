import { packageIdentity } from './desktop-package-identity.mjs';
import { forEachJoined } from './joined-tasks.mjs';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { assertClientArtifact } from './client-artifact.mjs';
import { readPiBundleProof } from './pi-bundle.mjs';
import { deploymentFileAllowed } from './deployment-files.mjs';

const root = resolve(import.meta.dirname, '..');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);

async function installedDependency(anchor, name, optional) {
  for (let cursor = anchor; ; cursor = dirname(cursor)) {
    const path = join(cursor, 'node_modules', name);
    try {
      return await realpath(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  if (optional) return undefined;
  throw new Error(`Missing declared runtime dependency ${name} from ${relative(root, anchor)}`);
}

/** Keep runtime edges; optional ambient-only peers are outside the production closure. */
export function runtimeDependencyNames(manifest) {
  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  return Object.keys(dependencies)
    .sort()
    .filter(
      (name) =>
        !(
          name.startsWith('@types/') &&
          manifest.peerDependenciesMeta?.[name]?.optional === true &&
          !Object.hasOwn(manifest.dependencies ?? {}, name) &&
          !Object.hasOwn(manifest.optionalDependencies ?? {}, name)
        ),
    );
}

/** No install scripts execute here; all links and native inputs belong to the returned closure. */
export async function stageLevel3Desktop(destination, options = {}) {
  const identity = packageIdentity(options.product === undefined ? false : options.product);
  if (!isAbsolute(destination)) throw new Error('Stage requires an absolute empty directory');
  const details = await lstat(destination);
  if (!details.isDirectory() || details.isSymbolicLink() || (await readdir(destination)).length)
    throw new Error('Stage requires an empty non-symlink directory');
  const stage = await realpath(destination);
  if (inside(root, stage) && !inside(join(root, 'out'), stage))
    throw new Error('Stage cannot overwrite repository inputs');
  const packages = new Map();
  async function visit(directory) {
    directory = await realpath(directory);
    if (packages.has(directory)) return packages.get(directory);
    const manifest = await readJson(join(directory, 'package.json'));
    if (!manifest.name || !manifest.version) throw new Error('Runtime package has no identity');
    const locator = relative(root, directory).split(sep).join('/');
    const id = createHash('sha256').update(locator).digest('hex').slice(0, 24);
    const bundle =
      manifest.name === '@axterm/engine-pi-core' ? readPiBundleProof(root, directory) : undefined;
    const runtimeManifest = bundle
      ? {
          ...manifest,
          dependencies: Object.fromEntries(
            bundle.externals.map((name) => [name, manifest.dependencies[name]]),
          ),
        }
      : manifest;
    const entry = {
      directory,
      manifest,
      runtimeManifest,
      bundle,
      id,
      locator,
      dependencies: new Map(),
    };
    packages.set(directory, entry);
    for (const name of runtimeDependencyNames(runtimeManifest)) {
      const optional =
        Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        manifest.peerDependenciesMeta?.[name]?.optional === true;
      const target = await installedDependency(directory, name, optional);
      if (target) entry.dependencies.set(name, await visit(target));
    }
    return entry;
  }
  const roots = new Map();
  for (const path of [
    'apps/desktop-host',
    'apps/web',
    'packages/infra/credential-vault',
    // A root alias lets the native preparation tool discover the copied module.
    'packages/infra/subprocess-local/node_modules/node-pty',
  ]) {
    const entry = await visit(join(root, path));
    roots.set(entry.manifest.name, entry);
  }
  // Expose the copied binding to the narrowly selected Electron native rebuild.
  const serialport = await realpath(
    await installedDependency(join(root, 'packages/plugins/connections'), 'serialport', false),
  );
  const serialBinding = await visit(
    await installedDependency(serialport, '@serialport/bindings-cpp', false),
  );
  roots.set(serialBinding.manifest.name, serialBinding);
  // The executable shell is not a dependency of Host. Collect its compiled
  // static roots separately so a transitively present package is also resolvable
  // from the shell's own module location in a clean application.
  const shellManifest = await readJson(join(root, 'apps/desktop/package.json'));
  for (const file of await readdir(join(root, 'apps/desktop/lib/shell'))) {
    if (!file.endsWith('.js')) continue;
    const path = join(root, 'apps/desktop/lib/shell', file);
    const ast = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier === 'electron')
        continue;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!shellManifest.dependencies?.[name])
        throw new Error(`Undeclared shell runtime root ${name}`);
      const entry = await visit(await installedDependency(join(root, 'apps/desktop'), name, false));
      roots.set(name, entry);
    }
  }
  const target = (entry) => join(stage, 'node_modules/.axterm', entry.id, 'package');
  await forEachJoined([...packages.values()], 4, async (entry) => {
    const workspace =
      inside(join(root, 'packages'), entry.directory) ||
      inside(join(root, 'apps'), entry.directory);
    if (workspace) await assertClientArtifact(entry.directory, entry.manifest);
    const artifactRoots = new Set(['lib', 'dist', 'assets', 'build']);
    for (const file of entry.manifest.files ?? []) {
      if (typeof file === 'string' && !file.startsWith('!'))
        artifactRoots.add(file.replace(/^\.\//, '').split('/')[0]);
    }
    if (entry.manifest.axterm?.bundle?.patch)
      artifactRoots.add(entry.manifest.axterm.bundle.patch.replace(/^\.\//, '').split('/')[0]);
    artifactRoots.delete('src');
    await cp(entry.directory, target(entry), {
      recursive: true,
      dereference: true,
      filter(path) {
        const parts = relative(entry.directory, path).split(sep);
        if (!deploymentFileAllowed(entry.manifest, parts.join('/'), workspace)) return false;
        if (!workspace || path === entry.directory) return true;
        return (
          artifactRoots.has(parts[0]) ||
          /^(?:package\.json|SOURCE\.json|LICENSE.*|COPYING.*|NOTICE.*)$/i.test(parts[0])
        );
      },
    });
    if (entry.bundle)
      await writeFile(
        join(target(entry), 'package.json'),
        JSON.stringify(entry.runtimeManifest, null, 2) + '\n',
      );
    if (workspace) await assertClientArtifact(target(entry), entry.manifest);
    if (
      workspace &&
      !(await readdir(target(entry))).some((name) =>
        ['lib', 'dist', 'cordis.patch.yml'].includes(name),
      )
    )
      throw new Error(`Built workspace artifacts missing for ${entry.manifest.name}`);
  });
  async function link(directory, name, entry) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(
      process.platform === 'win32' ? target(entry) : relative(dirname(path), target(entry)),
      path,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const resolved = await realpath(path);
    if (!inside(stage, resolved)) throw new Error('Runtime dependency escaped staging');
  }
  for (const entry of packages.values()) {
    for (const [name, dependency] of entry.dependencies)
      await link(join(target(entry), 'node_modules'), name, dependency);
  }
  for (const [name, entry] of roots) await link(join(stage, 'node_modules'), name, entry);
  await cp(join(root, 'apps/desktop/lib/shell'), join(stage, 'lib/shell'), { recursive: true });
  const shellRequire = createRequire(join(stage, 'lib/shell/main.js'));
  for (const name of roots.keys()) {
    // Web is an asset package and intentionally has no root JavaScript export.
    shellRequire.resolve(name === '@axterm/web' ? '@axterm/web/dist' : name);
  }
  await mkdir(join(stage, 'build'), { recursive: true });
  for (const name of ['icon.png', 'icon.icns', 'icon.ico'])
    await cp(join(root, 'apps/desktop/build', name), join(stage, 'build', name));
  await cp(
    join(root, 'compliance/UPDATE_FEED_RECORD.json'),
    join(stage, 'AXTERM_UPDATE_FEED.json'),
  );
  const version = (await readJson(join(root, 'package.json'))).version;
  await writeFile(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: identity.name,
        version,
        private: true,
        type: 'module',
        main: 'lib/shell/main.js',
        description: identity.productCutover
          ? 'Axterm Desktop'
          : 'Axterm Level 3 migration validation application',
        axterm: { migrationValidation: identity.migrationValidation },
        author: 'Axterm contributors',
        license: 'Apache-2.0',
        dependencies: Object.fromEntries(
          [...roots].map(([name, entry]) => [name, entry.manifest.version]),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt'])
    await cp(join(root, file), join(stage, file));
  for (const file of [
    'THIRD_PARTY_COMPONENTS.json',
    'THIRD_PARTY_LICENSE_TEXTS.json',
    'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
  ])
    await cp(join(root, 'compliance', file), join(stage, file));
  await cp(join(root, 'licenses'), join(stage, 'licenses'), { recursive: true });
  const inventory = {
    format: 1,
    purpose: identity.purpose,
    productCutover: identity.productCutover,
    electron: '44.3.0',
    platform: process.platform,
    arch: process.arch,
    bundledDependencies: [...packages.values()]
      .filter((entry) => entry.bundle)
      .map((entry) => ({
        owner: entry.manifest.name,
        bundle: `node_modules/.axterm/${entry.id}/package/dist/index.js`,
        components: entry.bundle.components.map(({ name, version, license }) => ({
          name,
          version,
          license,
        })),
      })),
    packages: [...packages.values()]
      .map((entry) => ({
        name: entry.manifest.name,
        version: entry.manifest.version,
        license: entry.manifest.license,
        id: entry.id,
        input: entry.locator,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
  await writeFile(join(stage, 'LEVEL3_PACKAGE.json'), JSON.stringify(inventory, null, 2) + '\n');
  return { stage, inventory, nativeDirectory: target(roots.get('node-pty')) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error('Usage: node scripts/stage-level3-desktop.mjs <absolute-empty-directory>');
  const result = await stageLevel3Desktop(args[0]);
  console.info(
    `Staged ${result.inventory.packages.length} runtime package instances without checkout links.`,
  );
}
