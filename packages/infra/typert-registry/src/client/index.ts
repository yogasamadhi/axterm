// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/typert/registry/src/client/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Browser face of the shared Typert runtime registry. */

import type { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '../service.ts';

/** Required services: none; this is the Client reflection root. */
export const inject: string[] = [];

/**
 * Install the same registry implementation used by the Host face.
 * @param ctx - Client Cordis root.
 */
export function apply(ctx: Context): void {
  new TypertRegistry(ctx);
}
