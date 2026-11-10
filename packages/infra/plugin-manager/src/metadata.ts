import { createReadStream, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { isAbsolute, join } from 'node:path';
import { Parser } from 'tar';
import { isExactPluginVersion } from '@axterm/infra-app-boot';
import type { PackageRunner } from './package-runner.ts';
import { PackageRunError } from './package-runner.ts';
import { registryPlan, registryUrl } from './registry.ts';
import { rcompare, satisfies, validRange } from 'semver';
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  axterm?: { bundle?: { patch: string | string[]; platforms?: readonly string[] } };
}
export interface InspectedPackage {
  readonly manifest: PackageMetadata;
  readonly spec: string;
  readonly registry?: string;
}
export function packageName(value: string): string {
  if (value.length > 214 || !NAME.test(value)) throw new PackageRunError('invalid-input');
  return value;
}
export function packageMetadata(value: unknown): PackageMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PackageRunError('invalid-input');
  const fields = value as Record<string, unknown>;
  if (typeof fields.name !== 'string' || typeof fields.version !== 'string')
    throw new PackageRunError('invalid-input');
  packageName(fields.name);
  if (!isExactPluginVersion(fields.version)) throw new PackageRunError('invalid-input');
  return fields as unknown as PackageMetadata;
}
export { registryUrl } from './registry.ts';
export function registrySpec(value: string): string {
  if (value.length > 512 || value.trim() !== value || /[\s\0]/u.test(value))
    throw new PackageRunError('invalid-input');
  const split = value.lastIndexOf('@');
  const name = split > 0 ? value.slice(0, split) : value;
  packageName(name);
  if (split > 0 && !/^[a-zA-Z0-9.*^~+<>=|_-]+$/u.test(value.slice(split + 1)))
    throw new PackageRunError('invalid-input');
  return value;
}
/** Exact target source wins over ambient scoped routing. Auth remains in pnpm configuration. */
export function scopedRegistryArguments(spec: string, registry: string): string[] {
  return spec.startsWith('@')
    ? ['--config.' + spec.slice(0, spec.indexOf('/')) + ':registry=' + registry]
    : [];
}
export class PackageInspector {
  readonly registry: string;
  constructor(
    private readonly runner: PackageRunner,
    registry = 'https://registry.npmjs.org/',
    private readonly fallbacks: readonly string[] = [],
  ) {
    this.registry = registryUrl(registry);
    this.fallbacks = [...this.fallbacks];
    registryPlan(this.registry, this.fallbacks);
  }
  async inspect(spec: string, signal?: AbortSignal): Promise<InspectedPackage> {
    signal?.throwIfAborted();
    if (isAbsolute(spec)) {
      const info = await stat(spec);
      const text = info.isDirectory()
        ? await boundedManifest(join(spec, 'package.json'))
        : await tarManifest(spec, signal);
      signal?.throwIfAborted();
      return { manifest: packageMetadata(JSON.parse(text)), spec: 'file:' + spec };
    }
    registrySpec(spec);
    const plan = registryPlan(this.registry, this.fallbacks);
    const split = spec.lastIndexOf('@'),
      name = split > 0 ? spec.slice(0, split) : spec,
      selector = split > 0 ? spec.slice(split + 1) : undefined;
    for (const [index, registry] of plan.entries()) {
      signal?.throwIfAborted();
      const result = await this.runner.run(
        [
          'view',
          spec,
          '--json',
          '--config.registry=' + registry,
          ...scopedRegistryArguments(spec, registry),
          '--config.ignore-scripts=true',
          '--config.ignore-pnpmfile=true',
          '--config.manage-package-manager-versions=false',
        ],
        { signal, timeoutMs: 30_000, requireCompleteOutput: true },
      );
      if (result.exitCode !== 0) {
        const reason = result.failure ?? 'unavailable';
        if (index + 1 < plan.length && ['network', 'timeout', 'not-found'].includes(reason))
          continue;
        throw new PackageRunError(reason);
      }
      let value: unknown;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        throw new PackageRunError('invalid-input');
      }
      const values = Array.isArray(value) ? value : [value];
      if (values.length > 256) throw new PackageRunError('capacity');
      const manifests = values.map(packageMetadata);
      if (
        !manifests.length ||
        manifests.some(
          (manifest) =>
            manifest.name !== name ||
            (selector &&
              (isExactPluginVersion(selector)
                ? manifest.version !== selector
                : validRange(selector) && !satisfies(manifest.version, selector))),
        )
      )
        throw new PackageRunError('invalid-input');
      const manifest = manifests.sort((a, b) => rcompare(a.version, b.version))[0]!;
      return { manifest, spec: manifest.name + '@' + manifest.version, registry };
    }
    throw new PackageRunError('unavailable');
  }
}
export async function boundedManifest(path: string, limit = 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024)
    throw new PackageRunError('invalid-input');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new PackageRunError('capacity');
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new PackageRunError('capacity');
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await file.close();
  }
}
export function boundedManifestSync(path: string): string {
  const file = openSync(path, 'r');
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new PackageRunError('capacity');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(file, bytes, offset, bytes.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    if (offset > 1024 * 1024) throw new PackageRunError('capacity');
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(file);
  }
}
/** Inspect data only. No package code, lifecycle hooks or archive extraction is executed. */
export async function tarManifest(path: string, signal?: AbortSignal): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new PackageRunError('capacity');
  const input = createReadStream(path, { signal });
  const inputDone = finished(input, { cleanup: true });
  void inputDone.catch(() => {});
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: 64 * 1024,
    maxDecompressionRatio: 100,
  });
  const done = Promise.withResolvers<void>();
  let manifest: Buffer | undefined,
    entries = 0,
    declared = 0;
  let failed = false;
  const fail = (cause: unknown) => {
    if (failed) return;
    failed = true;
    const error = cause instanceof Error ? cause : new PackageRunError('invalid-input');
    parser.abort(error);
    input.destroy(error);
    done.reject(error);
  };
  parser.on('error', fail);
  input.on('error', fail);
  parser.on('end', () => done.resolve());
  parser.on('entry', (entry) => {
    entries++;
    declared += entry.size;
    if (entries > 10_000 || declared > 256 * 1024 * 1024) {
      parser.abort(new PackageRunError('capacity'));
      return;
    }
    if (entry.path !== 'package/package.json') {
      entry.resume();
      return;
    }
    if (manifest || entry.type !== 'File' || entry.size > 1024 * 1024) {
      parser.abort(new PackageRunError('invalid-input'));
      return;
    }
    manifest = Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let bytes = 0;
    entry.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) parser.abort(new PackageRunError('capacity'));
      else chunks.push(chunk);
    });
    entry.on('end', () => {
      manifest = Buffer.concat(chunks);
    });
  });
  input.pipe(parser);
  try {
    await done.promise;
    if (!manifest) throw new PackageRunError('invalid-input');
    return manifest.toString('utf8');
  } finally {
    input.unpipe(parser);
    input.destroy();
    await inputDone.catch(() => {});
  }
}
