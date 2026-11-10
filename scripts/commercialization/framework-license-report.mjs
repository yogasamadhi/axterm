import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { frameworkNames, dshCommit } from '../dsh-framework.mjs';

/** Explicit, byte-pinned third-party workspace inputs; never widen the installed-package root. */
export function frameworkLicenseReport(root = resolve(import.meta.dirname, '../..')) {
  root = realpathSync(root);
  const pin = JSON.parse(readFileSync(join(root, 'compliance/DSH_FRAMEWORK_SOURCE.json'), 'utf8'));
  if (pin.commit !== dshCommit) throw new Error('Framework license pin mismatch');
  /** @type {Record<string, Array<{name: string, versions: string[], paths: string[], license: string}>>} */
  const report = {};
  const allowedPackagePaths = new Map();
  for (const folder of frameworkNames) {
    const directory = realpathSync(join(root, 'packages/framework', folder));
    if (directory !== join(root, 'packages/framework', folder))
      throw new Error('Framework license path must be canonical');
    const contents = {};
    for (const file of ['package.json', 'LICENSE']) {
      const bytes = readFileSync(join(directory, file));
      const expected = pin.files.find((entry) => entry.path === `vendor/${folder}/${file}`);
      if (
        !expected ||
        expected.bytes !== bytes.length ||
        expected.sha256 !== createHash('sha256').update(bytes).digest('hex')
      )
        throw new Error(
          'Framework license input differs from pinned source: ' + folder + '/' + file,
        );
      contents[file] = bytes;
    }
    const manifest = JSON.parse(contents['package.json']);
    if (!manifest.name?.startsWith('@deepseek-ai/') || manifest.license !== 'MIT')
      throw new Error('Unexpected framework license identity: ' + folder);
    (report[manifest.license] ??= []).push({
      name: manifest.name,
      versions: [manifest.version],
      paths: [directory],
      license: manifest.license,
    });
    allowedPackagePaths.set(`${manifest.name}\0${manifest.version}`, directory);
  }
  return { report, allowedPackagePaths };
}
