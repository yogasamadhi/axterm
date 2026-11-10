import { desktopPackageIdentity } from './desktop-package-identity.mjs';
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Resolve only a new-architecture engineering artifact, never an old default app.
 * @param {{result?: string | undefined, candidate?: string | undefined}} options
 * @param {NodeJS.Platform} platform
 */
export async function resolveLevel3PackagedArtifact(options, platform = process.platform) {
  if (!options.result && !options.candidate) return undefined;
  let appDirectory, resultIdentity;
  if (options.result) {
    const record = JSON.parse(await readFile(resolve(options.result), 'utf8'));
    if (
      !record ||
      typeof record !== 'object' ||
      !('purpose' in record) ||
      !('productCutover' in record) ||
      !('app' in record) ||
      typeof record.app !== 'string' ||
      !isAbsolute(record.app)
    )
      throw new Error('An explicit Level3 package result is required');
    resultIdentity = desktopPackageIdentity(record);
    appDirectory = await realpath(record.app);
  } else {
    const candidate = await realpath(options.candidate);
    appDirectory = await realpath(
      join(candidate, platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app'),
    );
  }
  const [inventory, manifest] = await Promise.all([
    readFile(join(appDirectory, 'LEVEL3_PACKAGE.json'), 'utf8').then(JSON.parse),
    readFile(join(appDirectory, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  const identity = desktopPackageIdentity(inventory, manifest);
  if (
    inventory.platform !== platform ||
    (resultIdentity && resultIdentity.purpose !== identity.purpose)
  )
    throw new Error('Artifact is not a prepared new-architecture desktop candidate');
  const resourcesDirectory = dirname(appDirectory);
  const artifactRoot =
    platform === 'darwin' ? dirname(dirname(resourcesDirectory)) : dirname(resourcesDirectory);
  if (platform === 'darwin' && resourcesDirectory !== join(artifactRoot, 'Contents/Resources'))
    throw new Error('Invalid macOS artifact layout');
  if (platform !== 'darwin' && resourcesDirectory !== join(artifactRoot, 'resources'))
    throw new Error('Invalid desktop artifact layout');
  const binaryDirectory =
    platform === 'darwin' ? join(artifactRoot, 'Contents/MacOS') : artifactRoot;
  const entries = await readdir(binaryDirectory, { withFileTypes: true });
  const binaries = entries.filter(
    (entry) =>
      entry.isFile() &&
      (platform === 'darwin'
        ? true
        : platform === 'win32'
          ? entry.name.endsWith('.exe') && !/^Uninstall.*\.exe$/iu.test(entry.name)
          : entry.name === identity.executableName),
  );
  if (binaries.length !== 1)
    throw new Error('Artifact must have one unambiguous desktop executable');
  const executablePath = join(binaryDirectory, binaries[0].name);
  await access(join(appDirectory, manifest.main));
  return { artifactRoot, appDirectory, resourcesDirectory, executablePath };
}
