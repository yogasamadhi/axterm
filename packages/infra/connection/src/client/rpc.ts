// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/client/connection/src/client/rpc.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/** Browser caller for generic Connection unary RPC channels. */

import {
  MAX_RPC_BINARY_BYTES,
  MAX_RPC_ATTACHMENTS,
  MAX_RPC_JSON_BYTES,
  MAX_RPC_RESPONSE_BYTES,
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from '../rpc.ts';
import type { ClientConnectionRpc, ConnectionRpcResult } from '../rpc.ts';
import { randomUuid } from './random-uuid.ts';

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * Transport this caller posts through; same signature as the global `fetch`.
 * Receives the document-relative route so a carrier resolves it against its own base.
 */
export type RpcFetch = (input: string | URL, init: RequestInit) => Promise<Response>;

/** Worker-local opener for decoded Gateway Remote streams; `uplink` carries the Client's items for the stream. */
export type RpcStreamOpen = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  uplink?: AsyncIterable<unknown>,
) => AsyncIterable<unknown>;

/**
 * Create the browser-backed generic RPC caller.
 * @param doFetch - transport override; defaults to the page's global fetch.
 * @param openStream - optional worker-local Gateway stream carrier.
 * @returns caller that owns request correlation and response-envelope validation.
 */
export function createWebConnectionRpc(
  doFetch?: RpcFetch,
  openStream?: RpcStreamOpen,
): ClientConnectionRpc {
  const send: RpcFetch = doFetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint);
      const rpcId = RpcId(randomUuid());
      const message: ClientRequest = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      };
      // The channel key is absolute; a page posts the document-relative form, and
      // a carrier that resolves against the Host root accepts the same form.
      const route = `${channel}/${endpoint}`.slice(1);
      const response = await send(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
      }
      const mediaType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      const bounded = await readBoundedResponse(
        response,
        mediaType === 'multipart/form-data' ? MAX_RPC_RESPONSE_BYTES : MAX_RPC_JSON_BYTES,
      );
      const full =
        mediaType === 'multipart/form-data'
          ? await parseBinaryResponse(bounded)
          : parseConnectionResponse(await bounded.json());
      signal?.throwIfAborted();
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
      }
      return full.result;
    },
    ...(openStream === undefined
      ? {}
      : {
          open(channel, endpoint, payload, signal, uplink) {
            assertTarget(channel, endpoint);
            if (channel !== '/api') {
              throw new Error(
                `connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`,
              );
            }
            return openStream(endpoint, payload, signal, uplink);
          },
        }),
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Response> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new RangeError('connection: unary response exceeds carrier limits');
  }
  if (!response.body) throw new TypeError('connection: missing unary response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new RangeError('connection: unary response exceeds carrier limits');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { headers: response.headers });
}

async function parseBinaryResponse(
  response: Response,
): Promise<ReturnType<typeof parseConnectionResponse>> {
  const body = await response.formData();
  const fields = new Map<string, string | Blob>();
  for (const [name, value] of body) {
    if (fields.has(name)) throw new TypeError('connection: invalid binary response fields');
    fields.set(name, value);
  }
  const metadata = fields.get('metadata');
  fields.delete('metadata');
  if (typeof metadata !== 'string') {
    throw new TypeError('connection: invalid binary response fields');
  }
  const envelope: unknown = JSON.parse(metadata);
  const full = parseConnectionResponse(envelope);
  if (
    !full.result.ok ||
    !isRecord(envelope) ||
    !Array.isArray(envelope.attachments) ||
    envelope.attachments.length === 0
  ) {
    throw new TypeError('connection: invalid binary response result');
  }
  if (
    envelope.attachments.length > MAX_RPC_ATTACHMENTS ||
    new TextEncoder().encode(metadata).byteLength > MAX_RPC_JSON_BYTES
  )
    throw new RangeError('connection: binary response exceeds carrier limits');
  const root = { value: full.result.value };
  let binaryBytes = 0;
  for (const attachment of envelope.attachments) {
    if (
      !isRecord(attachment) ||
      attachment.codec !== 'bytes' ||
      typeof attachment.part !== 'string' ||
      !Array.isArray(attachment.path)
    ) {
      throw new TypeError('connection: invalid binary response attachment');
    }
    const data = fields.get(attachment.part);
    fields.delete(attachment.part);
    if (!(data instanceof Blob)) {
      throw new TypeError('connection: invalid binary response fields');
    }
    binaryBytes += data.size;
    if (binaryBytes > MAX_RPC_BINARY_BYTES)
      throw new RangeError('connection: binary response exceeds carrier limits');
    let parent: object = root;
    let key: string | number = 'value';
    for (const segment of attachment.path) {
      const value: unknown = Reflect.get(parent, key);
      if (typeof value !== 'object' || value === null) {
        throw new TypeError('connection: invalid binary response path');
      }
      if (Array.isArray(value)) {
        if (
          typeof segment !== 'number' ||
          !Number.isSafeInteger(segment) ||
          segment < 0 ||
          segment >= value.length
        ) {
          throw new TypeError('connection: invalid binary response path');
        }
      } else if (
        segment === '__proto__' ||
        segment === 'prototype' ||
        segment === 'constructor' ||
        typeof segment !== 'string'
      ) {
        throw new TypeError('connection: invalid binary response path');
      }
      if (!Object.hasOwn(value, segment))
        throw new TypeError('connection: invalid binary response path');
      parent = value;
      key = segment;
    }
    if (Reflect.get(parent, key) !== null)
      throw new TypeError('connection: invalid binary response placeholder');
    Object.defineProperty(parent, key, {
      value: new Uint8Array(await data.arrayBuffer()),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (fields.size !== 0) throw new TypeError('connection: invalid binary response fields');
  return {
    rpcId: full.rpcId,
    result: { ok: true, value: root.value },
  };
}

function parseConnectionResponse(value: unknown): {
  readonly rpcId: RpcIdType;
  readonly result: ConnectionRpcResult<unknown>;
} {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope');
  }
  const result = value.result;
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result');
  if (result.ok === true) {
    return {
      rpcId: RpcId(value.rpcId),
      result: { ok: true, value: result.value },
    };
  }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('connection: invalid server-response result');
  }
  const error = result.error;
  if (
    typeof error.code !== 'string' ||
    typeof error.message !== 'string' ||
    !isRecord(error.details)
  ) {
    throw new TypeError('connection: invalid server-response failure');
  }
  return {
    rpcId: RpcId(value.rpcId),
    result: {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    },
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/');
  if (
    !CHANNEL_PATTERN.test(channel) ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !ENDPOINT_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`);
  }
}
