import { desktopPackageIdentity } from './desktop-package-identity.mjs';
import { appendFile, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevel3PackagedArtifact } from './level3-artifact.mjs';

/** Derive CI paths from the actual package result rather than assuming old app.asar layouts. */
export async function level3CiArtifacts(directory) {
  directory = await realpath(directory);
  const distribution = JSON.parse(
    await readFile(join(directory, 'LEVEL3_DISTRIBUTION_RESULT.json'), 'utf8'),
  );
  try {
    desktopPackageIdentity(distribution);
  } catch {
    throw Error('CI requires a completed new-architecture distribution');
  }
  if (
    typeof distribution.packageResult !== 'string' ||
    !Array.isArray(distribution.artifacts) ||
    !distribution.artifacts.length
  )
    throw Error('CI requires a completed new-architecture distribution');
  const artifact = await resolveLevel3PackagedArtifact({ result: distribution.packageResult });
  if (artifact.appDirectory !== distribution.app)
    throw Error('Distribution application differs from package result');
  for (const path of distribution.artifacts) {
    if (typeof path !== 'string' || dirname(await realpath(path)) !== directory)
      throw Error('CI artifact escaped its distribution directory');
  }
  return {
    AXTERM_LEVEL3_PACKAGE_RESULT: distribution.packageResult,
    AXTERM_CI_RESOURCES: artifact.resourcesDirectory,
    AXTERM_ARTIFACT_DIR: directory,
    AXTERM_CI_PLATFORM: `${{ darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]}-${process.arch}`,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !process.env.GITHUB_ENV)
    throw Error('CI artifact export requires a distribution and GITHUB_ENV');
  const entries = Object.entries(await level3CiArtifacts(resolve(process.argv[2])));
  if (entries.some(([, value]) => /[\r\n\0]/u.test(value)))
    throw Error('Invalid CI artifact environment');
  await appendFile(
    process.env.GITHUB_ENV,
    entries.map(([key, value]) => `${key}=${value}\n`).join(''),
  );
}
