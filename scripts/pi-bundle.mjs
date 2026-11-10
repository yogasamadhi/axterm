import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { piCommit } from './pi-source-provenance.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const piBundleFilename = 'pi-bundle.json';
export const piRuntimeExternals = Object.freeze(['ws']);
const owner = '@axterm/engine-pi-core';
const requiredInputs = [
  'vendor/pi/packages/agent/src/agent-loop.ts',
  'vendor/pi/packages/ai/src/providers/all.ts',
  'scripts/build-pi-engine.mjs',
  'packages/pi-engine/package.json',
];

function inputPath(root, name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\'))
    throw new Error('Invalid Pi bundle input path');
  const path = resolve(root, name);
  if (!path.startsWith(root + sep) || name.split('/').includes('..'))
    throw new Error('Pi bundle input escapes its source root');
  const actual = realpathSync(path);
  if (
    !actual.startsWith(root + sep) ||
    relative(root, actual).split(sep).join('/').startsWith('vendor/deepseek-harness/')
  )
    throw new Error('Pi bundle input escapes its independent source boundary');
  return path;
}

/** Pi owns the AI core. The producer records actual compiler inputs and external edges. */
export function writePiBundleProof(root, metafile) {
  root = realpathSync(root);
  const directory = join(root, 'packages/pi-engine');
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== owner) throw new Error('Unexpected Pi bundle owner');
  const inputs = new Set([
    ...Object.keys(metafile.inputs),
    'scripts/build-pi-engine.mjs',
    'packages/pi-engine/package.json',
  ]);
  if (requiredInputs.some((name) => !inputs.has(name)))
    throw new Error('Pi bundle must directly use the pinned Pi Agent and providers');
  if ([...inputs].some((name) => name.startsWith('vendor/deepseek-harness/')))
    throw new Error('DSH AI/framework code cannot enter the independent Pi engine');
  const components = new Map();
  for (const name of inputs) {
    const file = inputPath(root, name);
    if (!name.includes('node_modules/')) continue;
    let cursor = dirname(realpathSync(file));
    while (cursor.startsWith(root + sep)) {
      const path = join(cursor, 'package.json');
      if (existsSync(path)) {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.name && value.version) {
          const id = hash(`${value.name}\0${value.version}`).slice(0, 24);
          inputs.add(relative(root, path).split(sep).join('/'));
          const licenseFiles = readdirSync(cursor)
            .filter(
              (name) =>
                /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name) &&
                statSync(join(cursor, name)).isFile(),
            )
            .sort()
            .map((name) => {
              const bytes = readFileSync(join(cursor, name));
              const path = `bundled-licenses/${id}/${name}`;
              mkdirSync(dirname(join(directory, 'dist', path)), { recursive: true });
              writeFileSync(join(directory, 'dist', path), bytes);
              return { name, path, sha256: hash(bytes) };
            });
          components.set(id, {
            name: value.name,
            version: value.version,
            license: value.license ?? null,
            licenses: value.licenses,
            licenseFiles,
          });
          break;
        }
      }
      cursor = dirname(cursor);
    }
  }
  const externals = [
    ...new Set(
      Object.values(metafile.outputs).flatMap((output) =>
        output.imports
          .filter((entry) => entry.external && !isBuiltin(entry.path))
          .map((entry) =>
            entry.path.startsWith('@')
              ? entry.path.split('/').slice(0, 2).join('/')
              : entry.path.split('/')[0],
          ),
      ),
    ),
  ].sort();
  for (const name of externals)
    if (!manifest.dependencies?.[name]) throw new Error('Undeclared Pi bundle external: ' + name);
  if (JSON.stringify(externals) !== JSON.stringify(piRuntimeExternals))
    throw new Error('Pi bundle external edges changed; review its deployment contract');
  const proof = {
    format: 1,
    owner,
    sourceRevision: piCommit,
    bundle: { file: 'index.js', sha256: hash(readFileSync(join(directory, 'dist/index.js'))) },
    externals,
    inputs: [...inputs]
      .sort()
      .map((path) => ({ path, sha256: hash(readFileSync(inputPath(root, path))) })),
    components: [...components.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    ),
  };
  writeFileSync(join(directory, 'dist', piBundleFilename), JSON.stringify(proof, null, 2) + '\n');
  return proof;
}

/** Stale/tampered producers fail before any runtime dependency is omitted. */
export function readPiBundleProof(root, directory) {
  root = realpathSync(root);
  const proof = JSON.parse(readFileSync(join(directory, 'dist', piBundleFilename), 'utf8'));
  if (
    proof.format !== 1 ||
    proof.owner !== owner ||
    proof.sourceRevision !== piCommit ||
    proof.bundle?.file !== 'index.js' ||
    !Array.isArray(proof.inputs) ||
    !Array.isArray(proof.components) ||
    JSON.stringify(proof.externals) !== JSON.stringify(piRuntimeExternals) ||
    requiredInputs.some((name) => !proof.inputs.some((input) => input.path === name)) ||
    proof.inputs.some((input) => input.path.startsWith('vendor/deepseek-harness/'))
  )
    throw new Error('Invalid Pi bundle proof');
  if (hash(readFileSync(join(directory, 'dist/index.js'))) !== proof.bundle.sha256)
    throw new Error('Pi bundle output differs from its proof');
  const declared =
    JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies ?? {};
  for (const name of proof.externals)
    if (typeof name !== 'string' || !Object.hasOwn(declared, name))
      throw new Error('Unknown Pi bundle runtime edge');
  for (const input of proof.inputs)
    if (hash(readFileSync(inputPath(root, input.path))) !== input.sha256)
      throw new Error('Pi bundle input changed; rebuild before packaging: ' + input.path);
  return proof;
}

/** Self-contained installed evidence: every inlined component retains its exact root notices. */
export function inventoryPiBundleComponents(files, readFile) {
  const records = [];
  for (const path of files.filter((name) =>
    /^\/node_modules\/\.axterm\/[a-f0-9]{24}\/package\/dist\/pi-bundle\.json$/.test(name),
  )) {
    const directory = path.slice(0, -piBundleFilename.length);
    const manifest = JSON.parse(
      readFile(directory.slice(0, -'dist/'.length) + 'package.json').toString(),
    );
    const proof = JSON.parse(readFile(path).toString());
    if (
      manifest.name !== owner ||
      proof.owner !== owner ||
      proof.format !== 1 ||
      proof.sourceRevision !== piCommit ||
      proof.bundle?.file !== 'index.js' ||
      !Array.isArray(proof.components)
    )
      throw new Error('Invalid installed Pi bundle provenance');
    const bundle = directory + 'index.js';
    if (!files.includes(bundle) || hash(readFile(bundle)) !== proof.bundle.sha256)
      throw new Error('Installed Pi bundle bytes differ from provenance');
    for (const component of proof.components) {
      if (
        typeof component.name !== 'string' ||
        !component.name ||
        typeof component.version !== 'string' ||
        !component.version ||
        !Array.isArray(component.licenseFiles)
      )
        throw new Error('Invalid bundled component identity');
      const licenseFiles = component.licenseFiles.map((file) => {
        if (
          typeof file.path !== 'string' ||
          !/^bundled-licenses\/[a-f0-9]{24}\/[A-Za-z0-9._-]+$/.test(file.path)
        )
          throw new Error('Invalid bundled license path');
        const absolute = directory + file.path;
        if (!files.includes(absolute) || hash(readFile(absolute)) !== file.sha256)
          throw new Error('Bundled license bytes differ from provenance');
        return { path: absolute, sha256: file.sha256 };
      });
      records.push({ ...component, manifestPath: path, licenseFiles, bundledIn: bundle });
    }
  }
  return records;
}
