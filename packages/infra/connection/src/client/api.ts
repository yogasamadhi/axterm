// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/client/api.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Browser-safe Connection protocol and shared application value exports. */

export type {
  ClientRequest,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RpcResult,
  ServerResponse,
} from '../rpc.ts';
export { RpcId, transportError } from '../rpc.ts';

import type { RpcResponse, RpcResult } from '../rpc.ts';

/**
 * Return the business result carried by an RPC response.
 * @param response - RPC response to unwrap.
 * @returns the response's business result.
 */
export function resultOf<T>(response: RpcResponse<T>): RpcResult<T> {
  return response.result;
}
