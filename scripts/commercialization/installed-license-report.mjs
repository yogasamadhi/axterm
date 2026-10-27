import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '../..');

/**
 * Root of the installed production dependency graph. Every installed package
 * path reported by the package manager must stay inside this root.
 */
export const installedPackagesRoot = resolve(repositoryRoot, 'node_modules/.pnpm');

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Installed production dependency graph grouped by declared license.
 *
 * The report shape is the frozen contract of the license, SBOM and
 * attribution gates: `{ license: [{ name, versions, paths, license }] }`.
 */
export function installedLicenseReport() {
  return JSON.parse(
    execFileSync(pnpmCommand, ['licenses', 'list', '--json', '--prod'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
}
