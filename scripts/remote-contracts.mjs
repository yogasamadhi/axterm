import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WorkspaceTypertGenerator,
  writeWorkspaceArtifacts,
} from '../packages/tooling/remote-generator/lib/index.js';

const beneath = (root, path) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep);
};
const remoteFiles = [
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
];
/** Check the exact actual generated outputs; never initialize a Profile or touch business data. */
export async function checkRemoteArtifacts(root, artifacts) {
  root = await realpath(root);
  if (!artifacts.length) throw Error('No generated Host contributors found');
  const seen = new Set();
  let files = 0;
  for (const artifact of artifacts) {
    if (
      !['host', 'client'].includes(artifact.face) ||
      typeof artifact.packageRoot !== 'string' ||
      isAbsolute(artifact.packageRoot)
    )
      throw Error('Invalid generated artifact owner');
    const owner = resolve(root, artifact.packageRoot);
    if (!beneath(root, owner)) throw Error('Generated artifact owner escaped workspace');
    const directory = resolve(owner, 'lib');
    if (!beneath(owner, await realpath(directory))) throw Error('Generated output escaped owner');
    const identity = owner + ':' + artifact.face;
    if (seen.has(identity)) throw Error('Duplicate generated artifact owner');
    seen.add(identity);
    const expected = new Map([
      [`typert.${artifact.face}.js`, artifact.js],
      [`typert.${artifact.face}.d.ts`, artifact.dts],
    ]);
    if (artifact.remote !== undefined) {
      expected.set(remoteFiles[0], artifact.remote.js);
      expected.set(remoteFiles[1], artifact.remote.dts);
      expected.set(remoteFiles[2], artifact.remote.dtsMap);
    } else if (artifact.face === 'host') {
      for (const name of remoteFiles) {
        const exists = await lstat(resolve(directory, name)).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (exists)
          throw Error(`Retired Remote client output remains: ${artifact.packageRoot}/${name}`);
      }
    }
    for (const [name, content] of expected) {
      if (typeof content !== 'string') throw Error('Invalid generated artifact content');
      const path = resolve(directory, name);
      let canonical;
      try {
        canonical = await realpath(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw Error(`Generated Remote output missing: ${artifact.packageRoot}/lib/${name}`, {
          cause: error,
        });
      }
      if (!beneath(owner, canonical)) throw Error('Generated output escaped owner');
      if ((await readFile(canonical, 'utf8')) !== content)
        throw Error(`Generated Remote output is stale: ${artifact.packageRoot}/lib/${name}`);
      files++;
    }
  }
  return { contributors: artifacts.length, files };
}

export async function remoteContracts(root, mode = '--check') {
  if (!['--check', '--generate'].includes(mode)) throw Error('Expected --check or --generate');
  root = await realpath(root);
  await access(resolve(root, 'tsconfig.remote.host.json'));
  const artifacts = new WorkspaceTypertGenerator(root, {
    hostConfig: 'tsconfig.remote.host.json',
  }).generateContributors(['host']);
  if (mode === '--generate') writeWorkspaceArtifacts(root, artifacts);
  return checkRemoteArtifacts(root, artifacts);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3)
    throw Error('Usage: node scripts/remote-contracts.mjs [--check|--generate]');
  console.log(
    'Generated Remote contracts:',
    await remoteContracts(resolve(import.meta.dirname, '..'), process.argv[2]),
  );
}
