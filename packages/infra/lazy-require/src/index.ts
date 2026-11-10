// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/util/lazy-require/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Caller-relative lazy loading for CommonJS-compatible Host dependencies. */

import { createRequire } from 'node:module';

/**
 * Create a successful-result cache around Node's caller-relative `require`.
 * A failed load is not cached, so a corrected installation can be retried.
 * @param specifier - Literal dependency specifier declared by the caller package.
 * @param parentURL - Caller's `import.meta.url`, which owns package resolution.
 * @returns a zero-argument loader that resolves the dependency on first use.
 */
export function createLazyRequire<T>(specifier: string, parentURL: string | URL): () => T {
  const require = createRequire(parentURL);
  let loaded = false;
  let value: T;
  return () => {
    if (!loaded) {
      value = require(specifier) as T;
      loaded = true;
    }
    return value;
  };
}
