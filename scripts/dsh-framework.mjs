import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const frameworkNames = Object.freeze([
  'cosmokit',
  'cordis',
  'schemastery',
  'loader',
  'include',
  'group',
  'timer',
  'hmr',
  'logger-console',
]);
export const dshCommit = 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159';
const root = resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function collectFrameworkFiles(sourceRoot) {
  const result = [];
  async function collect(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      if (entry.isSymbolicLink()) throw new Error('Framework source cannot contain symbolic links');
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) await collect(filename);
      else {
        const bytes = await readFile(filename);
        result.push({
          path: relative(sourceRoot, filename).replaceAll('\\', '/'),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
      }
    }
  }
  for (const name of frameworkNames) {
    for (const leaf of ['package.json', 'tsconfig.json', 'LICENSE']) {
      const path = `vendor/${name}/${leaf}`;
      const bytes = await readFile(join(sourceRoot, path));
      result.push({ path, bytes: bytes.length, sha256: hash(bytes) });
    }
    await collect(join(sourceRoot, 'vendor', name, 'src'));
    if (name === 'timer') await collect(join(sourceRoot, 'vendor', name, 'locale'));
  }
  const license = await readFile(join(sourceRoot, 'LICENSE'));
  result.push({ path: 'LICENSE', bytes: license.length, sha256: hash(license) });
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function checkFrameworkSource(repositoryRoot = root) {
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, 'compliance/DSH_FRAMEWORK_SOURCE.json'), 'utf8'),
  );
  const source = join(repositoryRoot, 'vendor/deepseek-harness');
  const files = await collectFrameworkFiles(source);
  if (manifest.commit !== dshCommit || JSON.stringify(files) !== JSON.stringify(manifest.files)) {
    throw new Error('Pinned Cordis framework source differs from its recorded bytes');
  }
  for (const name of frameworkNames) {
    const original = await readFile(join(source, 'vendor', name, 'package.json'));
    const prepared = await readFile(
      join(repositoryRoot, 'packages/framework', name, 'package.json'),
    );
    if (!original.equals(prepared)) throw new Error(`Framework manifest was modified: ${name}`);
  }
  return source;
}

export async function prepareFramework(repositoryRoot = root) {
  const source = await checkFrameworkSource(repositoryRoot);
  for (const name of frameworkNames) {
    const destination = join(repositoryRoot, 'packages/framework', name);
    await mkdir(destination, { recursive: true });
    await rm(join(destination, 'src'), { recursive: true, force: true });
    await cp(join(source, 'vendor', name, 'src'), join(destination, 'src'), { recursive: true });
    await cp(join(source, 'vendor', name, 'LICENSE'), join(destination, 'LICENSE'));
    if (name === 'timer')
      await cp(join(source, 'vendor', name, 'locale'), join(destination, 'locale'), {
        recursive: true,
      });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check') {
    await checkFrameworkSource();
    console.info('Pinned DSH framework source and original manifests verified.');
  } else if (process.argv[2] === '--prepare') await prepareFramework();
  else throw new Error('Usage: node scripts/dsh-framework.mjs --check|--prepare');
}
