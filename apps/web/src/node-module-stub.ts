// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from apps/web/src/node-module-stub.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** The unchanged Loader receives its browser module system before resolving entries. */
export function createRequire(): never {
  throw new Error('BROWSER_NATIVE_RESOLUTION_FORBIDDEN');
}
export type LoadHookContext = never;
