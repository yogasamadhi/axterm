import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { WebBootGraph, ClientModuleLoader } from '@axterm/infra-client-modules/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GraphChannels } from '../../packages/infra/client-hmr/src/channels.ts';
import * as ClientHmr from '../../packages/infra/client-hmr/src/client/index.ts';

afterEach(() => vi.unstubAllGlobals());
function graph(rev = 'initial'): WebBootGraph {
  return { rev, release: { version: '0.10.0' }, entries: [], batches: [] };
}
class ResponsePort extends EventEmitter {
  readonly writes: string[] = [];
  status = 0;
  blocked = false;
  destroyed = false;
  closed = false;
  writeHead(status: number) {
    this.status = status;
    return this;
  }
  write(line: string) {
    this.writes.push(line);
    return !this.blocked;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  end() {
    this.finish();
    return this;
  }
  finish() {
    this.closed = true;
    this.emit('close');
  }
  get response() {
    return this as unknown as ServerResponse;
  }
}
it('coalesces slow-peer graph replacements and waits for actual response closure', async () => {
  let current = graph();
  const channels = new GraphChannels(() => current),
    port = new ResponsePort();
  port.blocked = true;
  channels.connect(port.response, new AbortController().signal);
  for (let index = 0; index < 100; index++) {
    current = graph('graph-' + index);
    channels.publish();
  }
  channels.heartbeat();
  expect(port.writes).toHaveLength(1);
  port.blocked = false;
  port.emit('drain');
  expect(port.writes).toHaveLength(2);
  expect(port.writes[1]).toContain('graph-99');
  let closed = false;
  const closing = channels.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(port.destroyed).toBe(true);
  expect(closed).toBe(false);
  port.finish();
  await closing;
  expect(closed).toBe(true);
});
it('bounds subscribers and frame bytes and releases a channel when its authenticated Peer ends', async () => {
  const channels = new GraphChannels(() => graph()),
    ports = Array.from({ length: 17 }, () => new ResponsePort()),
    abort = new AbortController();
  for (const port of ports) channels.connect(port.response, abort.signal);
  expect(ports.slice(0, 16).every((port) => port.status === 200)).toBe(true);
  expect(ports[16]!.status).toBe(503);
  abort.abort();
  expect(ports.slice(0, 16).every((port) => port.destroyed)).toBe(true);
  for (const port of ports) port.finish();
  await channels.close();
  const oversized = new GraphChannels(() => graph('x'.repeat(2 * 1024 * 1024))),
    rejected = new ResponsePort();
  oversized.connect(rejected.response, new AbortController().signal);
  expect(rejected.status).toBe(503);
  expect(rejected.writes).toEqual([]);
  await oversized.close();
});
it('parses split UTF-8 and CRLF frames and joins cancellation of a blocked reader', async () => {
  const abort = new AbortController(),
    values: unknown[] = [],
    cancel = vi.fn();
  const encoded = new TextEncoder().encode(
    'data: ' + JSON.stringify({ type: 'graph', graph: graph('汉字🙂') }) + '\r\n\r\n',
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index++)
        controller.enqueue(encoded.slice(index, index + 1));
    },
    cancel,
  });
  await ClientHmr.readGraphEvents(
    async () => new Response(body),
    abort.signal,
    (value) => {
      values.push(value);
      abort.abort();
    },
  );
  expect(values).toEqual([{ type: 'graph', graph: graph('汉字🙂') }]);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});
it('rejects oversized stream frames and releases the reader', async () => {
  const cancel = vi.fn(),
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1).fill(97));
      },
      cancel,
    });
  await expect(
    ClientHmr.readGraphEvents(
      async () => new Response(body),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow('CAPACITY');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});
it('parses individually bounded frames when a read includes the end of one and the next frame', async () => {
  const first = new TextEncoder().encode(
    'data: ' +
      JSON.stringify({ type: 'graph', graph: graph('x'.repeat(2 * 1024 * 1024 - 200)) }) +
      '\n\n',
  );
  const next = new TextEncoder().encode(
    'data: ' + JSON.stringify({ type: 'graph', graph: graph() }) + '\n\n',
  );
  const last = new Uint8Array(150 + next.length);
  last.set(first.slice(-150));
  last.set(next, 150);
  const abort = new AbortController(),
    received: unknown[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.slice(0, -150));
      controller.enqueue(last);
    },
  });
  await ClientHmr.readGraphEvents(
    async () => new Response(body),
    abort.signal,
    (value) => {
      received.push(value);
      if (received.length === 2) abort.abort();
    },
  );
  expect(received).toHaveLength(2);
  expect(body.locked).toBe(false);
});
it('can unload its own transport Fiber while root-owned entry reconciliation continues', async () => {
  const ctx = new Context(),
    ready = Promise.withResolvers<void>(),
    synced = Promise.withResolvers<void>(),
    cancelled = vi.fn();
  let fiber: Fiber | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: ' + JSON.stringify({ type: 'graph', graph: graph() }) + '\n\n',
        ),
      );
    },
    cancel: cancelled,
  });
  vi.stubGlobal('__AXTERM_TRANSPORT__', { fetch: async () => new Response(body) });
  ctx.provide('modules', {
    entries: {
      sync: async () => {
        await ready.promise;
        await fiber!.dispose();
        synced.resolve();
      },
    },
  } as unknown as ClientModuleLoader);
  try {
    fiber = ctx.plugin(ClientHmr);
    await fiber;
    ready.resolve();
    await synced.promise;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  } finally {
    await ctx.fiber.dispose();
  }
});
