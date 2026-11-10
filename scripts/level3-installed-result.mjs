import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevel3PackagedArtifact } from './level3-artifact.mjs';

/** Bind installed-package journeys to the relocated, explicitly validated application. */
export async function writeInstalledLevel3Result(candidate, output) {
  if (!isAbsolute(candidate) || !isAbsolute(output))
    throw Error('Installed artifact paths must be absolute');
  const artifact = await resolveLevel3PackagedArtifact({ candidate });
  const inventory = JSON.parse(
    await readFile(join(artifact.appDirectory, 'LEVEL3_PACKAGE.json'), 'utf8'),
  );
  const record = {
    purpose: inventory.purpose,
    productCutover: inventory.productCutover,
    app: artifact.appDirectory,
  };
  await writeFile(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return record;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw Error('Usage: level3-installed-result.mjs <application> <new-result-file>');
  await writeInstalledLevel3Result(process.argv[2], process.argv[3]);
}
