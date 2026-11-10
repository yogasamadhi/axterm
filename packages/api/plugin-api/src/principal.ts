// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/typert/protocol/src/principal.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Reads the non-owner caller of the current Remote call.
 * @module @axterm/plugin-api/principal
 */

import type { Principal, RemoteInvocation } from './types.ts';

/**
 * The identity a Remote-call producer records on durable output.
 * @param invocation - `ctx.invocation`; `undefined` outside a Remote call.
 * @returns the caller's principal when it is not the owner; `undefined` for the
 *   owner and for trusted in-process code outside a Remote call.
 */
export function principalOf(invocation: RemoteInvocation | undefined): Principal | undefined {
  const principal = invocation?.peer.principal;
  return principal?.kind === 'owner' ? undefined : principal;
}
