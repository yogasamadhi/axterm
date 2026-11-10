// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Registry trust/ordering adapted from packages/boot/plugin-manager/src/registry.ts
// at 8bd073392eef6f54e921a093b95076248eb08cbb. Axterm always selects an explicit URL.
import { PackageRunError } from './package-runner.ts';
/** Registry credentials stay in pnpm's auth configuration, never in an installation spec. */
export function registryUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new PackageRunError('invalid-input');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PackageRunError('invalid-input');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new PackageRunError('invalid-input');
  return url.href.endsWith('/') ? url.href : url.href + '/';
}

/** Configured fallback sources are explicitly declared public; unknown/private sources are queried alone. */
export function registryPlan(primary: string, fallbacks: readonly string[]): readonly string[] {
  if (!Array.isArray(fallbacks) || fallbacks.length > 8) throw new PackageRunError('invalid-input');
  const first = registryUrl(primary),
    publicSources = fallbacks.map(registryUrl);
  if (first !== 'https://registry.npmjs.org/' && !publicSources.includes(first)) return [first];
  return [...new Set([first, ...publicSources])];
}
