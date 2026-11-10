import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { TargetStreams } from '../../packages/plugins/connections/src/adapters/target-streams.ts';
import type { ConnectionStreamInput } from '@axterm/plugin-api/host';
import type { ConnectionService } from '../../packages/plugins/connections/src/application/connection-service.ts';
import type { ProxyService } from '../../packages/plugins/connections/src/application/proxy-service.ts';

function fixture(
  override: Partial<Pick<ConnectionService, 'create' | 'get' | 'handle' | 'close'>> = {},
  proxy?: ProxyService['connectForRoute'],
) {
  const id = randomUUID();
  const connections: Pick<ConnectionService, 'create' | 'get' | 'handle' | 'close'> = {
    create: vi.fn(() => ({ id }) as ReturnType<ConnectionService['create']>),
    get: vi.fn(() => ({ id, state: 'ready' }) as ReturnType<ConnectionService['get']>),
    handle: vi.fn(),
    close: vi.fn(async () => {}),
    ...override,
  };
  const route = vi.fn(proxy ?? (async () => undefined));
  return {
    connections,
    route,
    streams: new TargetStreams(connections, { connectForRoute: route }),
  };
}
const input = (port = 22): ConnectionStreamInput => ({
  target: { host: '127.0.0.1', port },
  proxy: { mode: 'direct' },
  username: 'fixture',
  jumpHostId: null,
  timeoutMs: 1000,
});
it('owns actual direct TCP bytes, cancellation and actual stream release', async () => {
  const peers = new Set<Socket>();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (data) => socket.write(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture');
  const f = fixture();
  try {
    const abort = new AbortController();
    const lease = await f.streams.open(input(address.port), abort.signal);
    const response = once(lease.stream, 'data');
    const payload = Buffer.alloc(4096, 0x71);
    lease.stream.write(payload);
    expect((await response)[0]).toEqual(payload);
    abort.abort();
    await lease.close();
    expect(lease.stream.closed).toBe(true);
    expect(f.streams.resourceCount()).toBe(0);
    await vi.waitFor(() => expect(peers.size).toBe(0));
  } finally {
    await f.streams.close();
    for (const p of peers) p.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('preserves proxy routing and joins a late proxied stream on owner cancellation', async () => {
  const pending = Promise.withResolvers<Duplex>();
  const f = fixture({}, () => pending.promise);
  const abort = new AbortController();
  const opening = f.streams.open(input(), abort.signal);
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(f.route).toHaveBeenCalledOnce());
  abort.abort();
  let closed = false;
  const closing = f.streams.close().then(() => {
    closed = true;
  });
  const release = Promise.withResolvers<void>();
  const stream = new Duplex({
    read() {},
    write(_data, _encoding, done) {
      done();
    },
    destroy(_error, done) {
      void release.promise.then(() => done());
    },
  });
  pending.resolve(stream);
  await vi.waitFor(() => expect(stream.destroyed).toBe(true));
  expect(closed).toBe(false);
  release.resolve();
  await rejected;
  await closing;
  expect(stream.closed).toBe(true);
  expect(f.streams.resourceCount()).toBe(0);
});
it('owns and revokes its approved jump connection while draining a stalled forward', async () => {
  const pending = Promise.withResolvers<NodeJS.ReadWriteStream>();
  const forwardOut = vi.fn(() => pending.promise);
  const close = vi.fn(async () => {
    pending.reject(new Error('SSH closed'));
  });
  const f = fixture({
    handle: () =>
      ({ forwardOut, onClose: () => () => {} }) as unknown as ReturnType<
        ConnectionService['handle']
      >,
    close,
  });
  const abort = new AbortController();
  const opening = f.streams.open({ ...input(), jumpHostId: randomUUID() }, abort.signal);
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(forwardOut).toHaveBeenCalledOnce());
  abort.abort();
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  expect(f.streams.resourceCount()).toBe(0);
  await f.streams.close();
});
