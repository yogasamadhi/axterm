import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const electermRoot = resolve(repositoryRoot, 'vendor/electerm');
export const expectedElectermCommit = '799bedef98c1deae676ae03041719de98d3b57f1';
export const expectedElectermVersion = '5.5.0';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function currentElectermCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: electermRoot,
    encoding: 'utf8',
  }).trim();
}

export function assertElectermBaseline() {
  const commit = currentElectermCommit();
  const packageVersion = readJson(resolve(electermRoot, 'package.json')).version;
  if (commit !== expectedElectermCommit)
    throw new Error(
      `Electerm baseline mismatch: expected ${expectedElectermCommit}, received ${commit}`,
    );
  if (packageVersion !== expectedElectermVersion)
    throw new Error(
      `Electerm package mismatch: expected ${expectedElectermVersion}, received ${packageVersion}`,
    );
  return { commit, packageVersion };
}
