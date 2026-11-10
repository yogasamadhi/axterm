import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isMap, parse, parseDocument } from 'yaml';
import { isExactPluginVersion } from '@axterm/infra-app-boot';
import { writeFileAtomic } from '@axterm/infra-atomic-write';
import { boundedManifest, packageName } from './metadata.ts';
import { PackageRunError, type PackageRunner } from './package-runner.ts';
export interface PendingBuild {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}
interface BuildTarget extends PendingBuild {
  readonly key: string;
}
type ObjectRecord = Record<string, unknown>;
function object(value: unknown): ObjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PackageRunError('invalid-input');
  return value as ObjectRecord;
}
async function optionalText(file: string): Promise<string | undefined> {
  try {
    return await boundedManifest(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function targets(directory: string): Promise<readonly BuildTarget[]> {
  const modulesText = await optionalText(join(directory, 'node_modules/.modules.yaml'));
  const lockText = await optionalText(join(directory, 'pnpm-lock.yaml'));
  if (!modulesText || !lockText) return [];
  const modules = object(parse(modulesText, { maxAliasCount: 0 }));
  const lock = object(parse(lockText, { maxAliasCount: 0 }));
  const packages = object(lock.packages ?? {}),
    keys = Object.keys(packages);
  const pending = [
    ...(Array.isArray(modules.pendingBuilds) ? modules.pendingBuilds : []),
    ...(Array.isArray(modules.ignoredBuilds) ? modules.ignoredBuilds : []),
  ];
  if (pending.length > 512 || keys.length > 4096) throw new PackageRunError('capacity');
  const result = new Map<string, BuildTarget>();
  for (const raw of pending) {
    if (typeof raw !== 'string') throw new PackageRunError('invalid-input');
    const key = keys.find((key) => raw === key || raw.startsWith(key + '('));
    if (!key) continue;
    const match = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/u.exec(key);
    if (!match) throw new PackageRunError('invalid-input');
    const name = packageName(match[1]!),
      entry = object(packages[key]);
    const version = typeof entry.version === 'string' ? entry.version : match[2]!;
    if (!isExactPluginVersion(version)) throw new PackageRunError('invalid-input');
    const resolution = object(entry.resolution ?? {});
    const id = createHash('sha256')
      .update(JSON.stringify([key, version, resolution.integrity ?? '', resolution.tarball ?? '']))
      .digest('hex');
    result.set(id, { id, name, version, key });
  }
  return [...result.values()];
}
export async function pendingBuilds(directory: string): Promise<readonly PendingBuild[]> {
  return (await targets(directory)).map(({ id, name, version }) => ({ id, name, version }));
}
/** Only a separate approval executes exact dependency builds; installation always disables scripts. */
export async function approveBuilds(
  directory: string,
  ids: readonly string[],
  runner: PackageRunner,
  signal: AbortSignal,
): Promise<void> {
  if (
    !ids.length ||
    ids.length > 64 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{64}$/u.test(id))
  )
    throw new PackageRunError('invalid-input');
  const available = await targets(directory),
    selected = ids.map((id) => available.find((target) => target.id === id));
  if (selected.some((target) => !target)) throw new PackageRunError('invalid-input');
  const file = join(directory, 'pnpm-workspace.yaml');
  const original = (await optionalText(file)) ?? '{}\n';
  const document = parseDocument(original);
  if (document.errors[0]) throw document.errors[0];
  if (!isMap(document.contents)) throw new PackageRunError('invalid-input');
  const previous = document.get('allowBuilds');
  if (previous !== undefined && !isMap(previous)) throw new PackageRunError('invalid-input');
  const approved = Object.fromEntries(selected.map((target) => [target!.key, true]));
  const runPolicy = parseDocument(original);
  runPolicy.set('allowBuilds', approved);
  runPolicy.set('dangerouslyAllowAllBuilds', false);
  for (const key of [
    'onlyBuiltDependencies',
    'onlyBuiltDependenciesFile',
    'neverBuiltDependencies',
    'ignoredBuiltDependencies',
  ])
    runPolicy.delete(key);
  await writeFileAtomic(file, String(runPolicy), { mode: 0o600 });
  try {
    const environment = await buildEnvironment(directory);
    const result = await runner.run(
      [
        'rebuild',
        '--config.ignore-scripts=false',
        '--config.ignore-pnpmfile=true',
        '--config.manage-package-manager-versions=false',
        '--',
        ...selected.map((target) => target!.key),
      ],
      { signal, timeoutMs: 30 * 60_000, env: environment },
    );
    if (result.exitCode !== 0) throw new PackageRunError(result.failure ?? 'unavailable');
    await clearCompletedBuilds(
      directory,
      selected.map((target) => target!.key),
    );
  } finally {
    if (!runner.cleanupFailed()) {
      for (const [key, allowed] of Object.entries(approved))
        document.setIn(['allowBuilds', key], allowed);
      await writeFileAtomic(file, String(document), { mode: 0o600 });
    }
  }
}
/** pnpm 11's selected rebuild leaves pendingBuilds intact; clear only the exact successfully joined targets. */
async function clearCompletedBuilds(directory: string, selected: readonly string[]): Promise<void> {
  const file = join(directory, 'node_modules/.modules.yaml');
  const document = parseDocument(await boundedManifest(file));
  if (document.errors[0]) throw document.errors[0];
  if (
    !isMap(document.contents) ||
    document.get('packageManager') !== 'pnpm@11.28.5' ||
    document.get('layoutVersion') !== 5
  )
    throw new PackageRunError('invalid-input');
  const value = object(document.toJS({ maxAliasCount: 0 }));
  for (const field of ['pendingBuilds', 'ignoredBuilds']) {
    const entries = value[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))
      throw new PackageRunError('invalid-input');
    document.set(
      field,
      entries.filter(
        (entry) => !selected.some((key) => entry === key || entry.startsWith(key + '(')),
      ),
    );
  }
  await writeFileAtomic(file, String(document), { mode: 0o600 });
}
async function buildEnvironment(directory: string): Promise<Readonly<Record<string, string>>> {
  const bin = join(directory, '.plugin-manager/bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    await writeFileAtomic(
      join(bin, 'node.cmd'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"' +
        process.execPath.replaceAll('%', '%%') +
        '" %*\r\n',
      { mode: 0o700 },
    );
  } else {
    const executable = "'" + process.execPath.replaceAll("'", "'\\''") + "'";
    await writeFileAtomic(
      join(bin, 'node'),
      '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ' + executable + ' "$@"\n',
      { mode: 0o700 },
    );
  }
  return {
    PATH: bin + delimiter + (process.env.PATH ?? ''),
    npm_node_execpath: process.execPath,
    ELECTRON_RUN_AS_NODE: '1',
  };
}
