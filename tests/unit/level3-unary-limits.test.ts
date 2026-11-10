import { expect, it, vi } from 'vitest';
import { createWebConnectionRpc } from '../../packages/infra/connection/src/client/rpc.ts';
import {
  MAX_RPC_ATTACHMENTS,
  MAX_RPC_BINARY_BYTES,
  MAX_RPC_JSON_BYTES,
} from '../../packages/infra/connection/src/rpc.ts';

it('cancels a chunked oversized response and releases the reader without trusting content-length', async () => {
  const cancelled = vi.fn();
  const chunk = new Uint8Array(1024 * 1024);
  const rpc = createWebConnectionRpc(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel: cancelled,
        }),
        { headers: { 'content-type': 'application/json', 'content-length': '1' } },
      ),
  );
  await expect(rpc.call('/api', 'desktop/health', {}, undefined)).rejects.toThrow(
    'exceeds carrier limits',
  );
  expect(cancelled).toHaveBeenCalledOnce();
});

it('rejects an oversized declared response before reading its body', async () => {
  const cancelled = vi.fn();
  const rpc = createWebConnectionRpc(
    async () =>
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { 'content-length': String(MAX_RPC_JSON_BYTES + 1) },
      }),
  );
  await expect(rpc.call('/api', 'desktop/health', {}, undefined)).rejects.toThrow(
    'exceeds carrier limits',
  );
  expect(cancelled).toHaveBeenCalledOnce();
});

it.each(['valid', 'bytes', 'count', 'prototype'] as const)(
  'validates multipart output ownership and budgets: %s',
  async (kind) => {
    const rpc = createWebConnectionRpc(async (_input, init) => {
      const { rpcId } = JSON.parse(String(init.body)) as { rpcId: string };
      const parts = new FormData();
      const count = kind === 'count' ? MAX_RPC_ATTACHMENTS + 1 : 1;
      const value: Record<string, unknown> =
        kind === 'prototype' ? JSON.parse('{"__proto__":null}') : { data: null };
      const attachments = Array.from({ length: count }, (_, i) => ({
        part: `bytes-${i}`,
        path: [kind === 'prototype' ? '__proto__' : 'data'],
        codec: 'bytes',
      }));
      for (const { part } of attachments)
        parts.set(
          part,
          new Blob([new Uint8Array(kind === 'bytes' ? MAX_RPC_BINARY_BYTES + 1 : 3)]),
        );
      parts.set(
        'metadata',
        JSON.stringify({
          type: 'server-response',
          rpcId,
          result: { ok: true, value },
          attachments,
        }),
      );
      return new Response(parts);
    });
    const result = rpc.call('/api', 'desktop/health', {}, undefined);
    if (kind === 'valid')
      await expect(result).resolves.toEqual({ ok: true, value: { data: new Uint8Array(3) } });
    else
      await expect(result).rejects.toThrow(
        kind === 'prototype' ? 'invalid binary response path' : 'exceeds carrier limits',
      );
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  },
);
