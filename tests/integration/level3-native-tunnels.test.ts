import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer, type Socket, type Server } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import type { SshConnectionHandle } from '../../packages/plugins/connections/src/ports/ssh-transport.ts';
import type { Connection, TunnelProfile } from '@axterm/plugin-api/connections';
import { NativeTunnels } from '../../packages/plugins/connections/src/adapters/tunnels.ts';

import { Tunnels } from '../../packages/plugins/connections/src/application/tunnels.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const address = (server: Server): number => {
  const value = server.address();
  if (!value || typeof value === 'string') throw new Error('Fixture did not bind');
  return value.port;
};
async function fixture() {
  const sockets = new Set<Socket>();
  const servers = new Map<number, Server>();
  const serverCloses = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  let closes = 0;
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const echo = createServer((socket) => own(socket).pipe(socket));
  echo.listen(0, '127.0.0.1');
  await once(echo, 'listening');
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => echo.close(() => done()));
  });
  const control = {
    onClose(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    forwardOut: async (_source: unknown, target: { host: string; port: number }) => {
      const socket = own(createConnection({ host: target.host, port: target.port }));
      await once(socket, 'connect');
      return socket;
    },
    forwardIn: async (
      host: string,
      port: number,
      incoming: Parameters<SshConnectionHandle['forwardIn']>[2],
    ) => {
      const server = createServer({ allowHalfOpen: true }, (socket) =>
        incoming(
          {
            sourceHost: '127.0.0.1',
            sourcePort: socket.remotePort ?? 0,
            destinationHost: host,
            destinationPort: address(server),
          },
          own(socket),
        ),
      );
      server.listen(port, host);
      await once(server, 'listening');
      const bound = address(server);
      servers.set(bound, server);
      return bound;
    },
    unforwardIn: async (_host: string, port: number) => {
      const server = servers.get(port);
      if (!server) return;
      servers.delete(port);
      const closed = new Promise<void>((done) => server.close(() => done()));
      serverCloses.add(closed);
      void closed.then(() => serverCloses.delete(closed));
    },
  };
  const connection = {
    handle: () => control as unknown as SshConnectionHandle,
    close: async () => {
      closes++;
      for (const listener of [...listeners]) listener();
      for (const socket of sockets) socket.destroy();
      for (const port of [...servers.keys()]) await control.unforwardIn('', port);
      await Promise.all([...serverCloses]);
    },
  };
  const transport = new NativeTunnels(connection, 3000);
  cleanups.push(async () => {
    await transport.close();
    await connection.close();
  });
  const now = new Date().toISOString();
  const profile: TunnelProfile = {
    id: randomUUID(),
    name: 'Controlled forwarding',
    hostId: randomUUID(),
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: address(echo),
    allowNonLoopback: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  return {
    transport,
    profile,
    sockets,
    control,
    connection,
    closes: () => closes,
    listenerCount: () => listeners.size,
  };
}
async function request(port: number, bytes: Buffer): Promise<Buffer> {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const received: Buffer[] = [];
  socket.on('data', (bytes) => received.push(bytes));
  await once(socket, 'connect');
  socket.end(bytes);
  await once(socket, 'close');
  return Buffer.concat(received);
}
it('streams large binary local and remote forwarding and unregisters without terminating the connection', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x6b);
  for (const type of ['local', 'remote'] as const) {
    const lease = await f.transport.start(
      randomUUID(),
      { ...f.profile, type },
      new AbortController().signal,
    );
    const received = await request(lease.bindPort, bytes);
    expect(createHash('sha256').update(received).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    await lease.close();
    expect(f.transport.resourceCount()).toBe(0);
  }
  expect(f.closes()).toBe(0);
});
it('handles fragmented SOCKS negotiation and preserves pipelined application bytes', async () => {
  const f = await fixture();
  const lease = await f.transport.start(
    randomUUID(),
    { ...f.profile, type: 'dynamic', targetHost: null, targetPort: null },
    new AbortController().signal,
  );
  const socket = createConnection({ host: '127.0.0.1', port: lease.bindPort });
  socket.on('error', () => {});
  cleanups.push(() => {
    socket.destroy();
  });
  let received = Buffer.alloc(0);
  socket.on('data', (bytes) => {
    received = Buffer.concat([received, bytes]);
  });
  await once(socket, 'connect');
  socket.write(Buffer.from([5]));
  socket.write(Buffer.from([1, 0]));
  await vi.waitFor(() => expect(received.subarray(0, 2)).toEqual(Buffer.from([5, 0])));
  const target = Buffer.from('127.0.0.1');
  const port = Buffer.alloc(2);
  port.writeUInt16BE(f.profile.targetPort!);
  const payload = Buffer.from('SOCKS_PIPELINED_BYTES');
  socket.write(Buffer.from([5, 1, 0, 3, target.length]));
  socket.write(Buffer.concat([target, port, payload]));
  await vi.waitFor(() => expect(received.subarray(12)).toEqual(payload));
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await lease.close();
  await closed;
  expect(f.transport.resourceCount()).toBe(0);
});
it('joins active sockets on cancellation and exposes a bind conflict without leaking its listener', async () => {
  const f = await fixture();
  const abort = new AbortController();
  const lease = await f.transport.start(randomUUID(), f.profile, abort.signal);
  await expect(
    f.transport.start(
      randomUUID(),
      { ...f.profile, bindPort: lease.bindPort },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  const socket = createConnection({ host: '127.0.0.1', port: lease.bindPort });
  socket.on('error', () => {});
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await once(socket, 'connect');
  abort.abort();
  await lease.close();
  await closed;
  expect(f.transport.resourceCount()).toBe(0);
});
it('closes the owning connection to cancel a stalled remote forwarding control', async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<number>();
  f.control.forwardIn = async () => pending.promise;
  const original = f.connection.close;
  f.connection.close = async () => {
    pending.reject(new Error('Controlled SSH close'));
    await original();
  };
  const abort = new AbortController();
  const started = f.transport.start(randomUUID(), { ...f.profile, type: 'remote' }, abort.signal);
  const rejected = expect(started).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  await rejected;
  expect(f.closes()).toBeGreaterThan(0);
  expect(f.transport.resourceCount()).toBe(0);
});

function logical(f: Awaited<ReturnType<typeof fixture>>) {
  const now = new Date().toISOString(),
    connection: Connection = {
      id: randomUUID(),
      hostId: f.profile.hostId,
      state: 'ready',
      reconnectAttempt: 0,
      nextReconnectAt: null,
      createdAt: now,
      updatedAt: now,
    };
  const service = new Tunnels(
    {
      list: () => [],
      get: () => {
        throw Error('No saved fixture');
      },
    },
    () => connection,
    f.transport,
    { changed: vi.fn() },
  );
  cleanups.push(() => service.close());
  return { service, connection, input: { connectionId: connection.id, profile: f.profile } };
}
it('retains five real loopback start-stop cycles and inspectable owner-loss failure until explicit stop', async () => {
  const f = await fixture(),
    l = logical(f);
  for (let index = 0; index < 5; index++) {
    const tunnel = await l.service.start(l.input);
    expect(tunnel.state).toBe('active');
    expect(tunnel.bindPort).toBeGreaterThan(0);
    await l.service.stop(tunnel.id);
    expect(l.service.resourceCount()).toBe(0);
    expect(f.listenerCount()).toBe(0);
  }
  const tunnel = await l.service.start(l.input);
  await f.connection.close();
  await vi.waitFor(() =>
    expect(l.service.list()).toContainEqual(
      expect.objectContaining({ id: tunnel.id, state: 'failed', errorCode: 'SSH_CONNECTION_LOST' }),
    ),
  );
  await l.service.stop(tunnel.id);
  expect(l.service.list()).toEqual([]);
  expect(l.service.resourceCount()).toBe(0);
  expect(f.listenerCount()).toBe(0);
});
it('retains typed logical bind-conflict metadata and releases every real transport listener', async () => {
  const f = await fixture(),
    l = logical(f);
  const active = await l.service.start(l.input);
  await expect(
    l.service.start({ ...l.input, profile: { ...f.profile, bindPort: active.bindPort } }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(l.service.list()).toContainEqual(
    expect.objectContaining({ state: 'failed', errorCode: 'TUNNEL_PORT_IN_USE' }),
  );
  expect(f.listenerCount()).toBe(1);
  await l.service.close();
  expect(l.service.resourceCount()).toBe(0);
  expect(f.listenerCount()).toBe(0);
});
