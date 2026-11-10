import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Connection, TunnelProfileInput } from '@axterm/plugin-api/connections';
import type {
  TunnelLease,
  TunnelTransport,
} from '../../packages/plugins/connections/src/ports/tunnels.ts';
import { Tunnels } from '../../packages/plugins/connections/src/application/tunnels.ts';

function fixture(start?: TunnelTransport['start']) {
  const hostId = randomUUID();
  const id = randomUUID();
  const now = new Date().toISOString();
  const connection: Connection = {
    id,
    hostId,
    state: 'ready',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const input: TunnelProfileInput = {
    name: 'Owned tunnel',
    hostId,
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: 22,
    allowNonLoopback: false,
  };
  let resources = 0;
  const leases = new Set<TunnelLease>();
  const transport: TunnelTransport = {
    start: vi.fn(
      start ??
        (async () => {
          const abort = new AbortController();
          resources++;
          const lease = {
            signal: abort.signal,
            bindPort: 12345,
            close: async () => {
              if (leases.delete(lease)) resources--;
              abort.abort();
            },
          };
          leases.add(lease);
          return lease;
        }),
    ),
    closeConnection: async () => {
      await Promise.all([...leases].map((lease) => lease.close()));
    },
    close: async () => {
      await Promise.all([...leases].map((lease) => lease.close()));
    },
    resourceCount: () => resources,
  };
  const events = vi.fn();
  const service = new Tunnels(
    {
      list: () => [],
      get: () => {
        throw new Error('No saved fixture profile');
      },
    },
    () => connection,
    transport,
    { changed: events },
  );
  return { service, transport, input, connection, events };
}
it('rejects mismatched Host identity and non-loopback binding before any forwarding is admitted', async () => {
  const f = fixture();
  expect(() =>
    f.service.start({
      connectionId: f.connection.id,
      profile: { ...f.input, hostId: randomUUID() },
    }),
  ).toThrow('does not match');
  expect(() =>
    f.service.start({
      connectionId: f.connection.id,
      profile: { ...f.input, bindHost: '0.0.0.0' },
    }),
  ).toThrow('opt-in');
  expect(f.transport.start).not.toHaveBeenCalled();
  await f.service.close();
});
it('bounds live tunnel metadata and drains every lease before accepting close as complete', async () => {
  const f = fixture();
  for (let index = 0; index < 64; index++)
    await f.service.start({ connectionId: f.connection.id, profile: f.input });
  await expect(
    f.service.start({ connectionId: f.connection.id, profile: f.input }),
  ).rejects.toThrow('capacity');
  expect(f.service.resourceCount()).toBe(64);
  await f.service.close();
  expect(f.service.list()).toEqual([]);
  expect(f.service.resourceCount()).toBe(0);
});
it('cancels a pending activation and waits for its late lease cleanup before stop returns', async () => {
  const admitted = Promise.withResolvers<TunnelLease>();
  const closed = Promise.withResolvers<void>();
  const abort = new AbortController();
  const close = vi.fn(() => {
    abort.abort();
    return closed.promise;
  });
  const f = fixture(async () => admitted.promise);
  const pending = f.service.start({ connectionId: f.connection.id, profile: f.input });
  const ended = expect(pending).rejects.toThrow('canceled');
  await vi.waitFor(() => expect(f.transport.start).toHaveBeenCalledOnce());
  const metadata = f.service.list()[0]!;
  let stopped = false;
  const stopping = f.service.stop(metadata.id).then(() => {
    stopped = true;
  });
  admitted.resolve({ signal: abort.signal, bindPort: 12345, close });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(stopped).toBe(false);
  closed.resolve();
  await ended;
  await stopping;
  expect(f.service.list()).toEqual([]);
  await f.service.close();
});
it('binds each logical tunnel before any transport IO and rejects a failed binding without publishing or leaking', async () => {
  const f = fixture();
  let allocated = '';
  const opening = f.service.start(
    { connectionId: f.connection.id, profile: f.input },
    undefined,
    (id) => {
      allocated = id;
      expect(f.transport.start).not.toHaveBeenCalled();
      expect(f.events).not.toHaveBeenCalled();
      expect(f.service.get(id).state).toBe('starting');
    },
  );
  expect(allocated).not.toBe('');
  await opening;
  await f.service.stop(allocated);
  f.transport.start = vi.fn(f.transport.start);
  f.events.mockClear();
  expect(() =>
    f.service.start({ connectionId: f.connection.id, profile: f.input }, undefined, () => {
      throw Error('BIND_FAILED');
    }),
  ).toThrow('BIND_FAILED');
  expect(f.service.list()).toEqual([]);
  expect(f.events).not.toHaveBeenCalled();
  await f.service.close();
});
