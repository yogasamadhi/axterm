// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/typert/protocol/src/remote-error.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** The one Remote failure class shared by owners, the Gateway, and consumers. */

import type { RemoteFailure } from './types.ts';
export { RemoteError } from './types.ts';

/**
 * Structurally identify a RemoteError thrown across module or realm copies of
 * this class. Mechanism-internal: the Gateway and test assertions use it;
 * business code receives typed failures and never needs it.
 * @param value - a caught value.
 * @returns the failure when the marker matches, otherwise undefined.
 */
export function remoteErrorOf(value: unknown): RemoteFailure | undefined {
  // Structural, not instanceof: an Error thrown in another realm (iframe, VM)
  // fails instanceof Error here, so the marker plus the code field is the test.
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { isAXTERMRemoteError?: unknown }).isAXTERMRemoteError === true &&
    typeof (value as { code?: unknown }).code === 'string'
  ) {
    return value as RemoteFailure;
  }
  return undefined;
}
