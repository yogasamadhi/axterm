// Copyright (c) 2021-present Shigma; Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/boot/hmr/src/error.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
import type { Context } from '@deepseek-ai/cordis';

/** Report module failure locations without logging source fragments or arbitrary thrown data. */
export function handleError(ctx: Context, error: unknown): void {
  ctx.logger.warn(
    'HMR_MODULE_RELOAD_FAILED: inspect the changed plugin; the previous generation may require restart',
  );
  if (
    typeof error !== 'object' ||
    error === null ||
    !('errors' in error) ||
    !Array.isArray(error.errors)
  )
    return;
  for (const failure of error.errors) {
    if (typeof failure !== 'object' || failure === null || !('location' in failure)) continue;
    const location: unknown = failure.location;
    if (typeof location !== 'object' || location === null) continue;
    if (!('file' in location) || typeof location.file !== 'string') continue;
    if (!('line' in location) || !Number.isInteger(location.line)) continue;
    if (!('column' in location) || !Number.isInteger(location.column)) continue;
    ctx.logger.warn('Module: %s:%s:%s', location.file, location.line, location.column);
  }
}
