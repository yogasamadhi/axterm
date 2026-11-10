import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
/** Refuse a declared browser entry that would disappear outside the source checkout. */
export async function assertClientArtifact(directory, manifest) {
  if (manifest.axterm?.client?.platform !== 'web') return;
  const browser = manifest.exports?.['./client']?.browser;
  if (typeof browser !== 'string' || !browser.startsWith('./'))
    throw new Error(`Missing browser Client export: ${manifest.name}`);
  const root = await realpath(directory);
  const artifact = resolve(root, browser);
  if (!artifact.startsWith(root + sep))
    throw new Error(`Browser Client export escapes package: ${manifest.name}`);
  const actual = await realpath(artifact).catch(() => undefined);
  if (actual && !actual.startsWith(root + sep))
    throw new Error(`Browser Client export escapes package: ${manifest.name}`);
  const details = await lstat(artifact).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink())
    throw new Error(`Built browser Client artifact missing: ${manifest.name}`);
}
