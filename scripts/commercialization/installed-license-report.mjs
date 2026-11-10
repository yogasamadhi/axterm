import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { frameworkLicenseReport } from './framework-license-report.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

/**
 * Root of the installed production dependency graph. Every installed package
 * path reported by the package manager must stay inside this root.
 */
export const installedPackagesRoot = resolve(repositoryRoot, 'node_modules/.pnpm');

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Installed production dependency graph grouped by declared license.
 * pnpm 11.28 requires explicit workspace selection; root-only production is empty.
 *
 * The report shape is the frozen contract of the license, SBOM and
 * attribution gates: `{ license: [{ name, versions, paths, license }] }`.
 */
export function installedLicenseReport() {
  const report = JSON.parse(
    execFileSync(pnpmCommand, ['--filter', '*', 'licenses', 'list', '--json', '--prod'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  for (const [license, records] of Object.entries(frameworkLicenseReport().report)) {
    const existing = (report[license] ??= []);
    for (const record of records) {
      if (Object.values(report).some((group) => group.some((entry) => entry.name === record.name)))
        throw new Error(
          'Framework unexpectedly duplicated in installed license report: ' + record.name,
        );
      existing.push(record);
    }
  }
  return report;
}
