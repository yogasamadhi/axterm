import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { RealtimeHub } from './realtime-hub';
import { TunnelService } from './tunnel-service';

describe('TunnelService', () => {
  it('repeatedly starts and stops loopback listeners without leaking resources', async () => {
    const database = await ProductDatabase.open();
    const connection = fakeConnections();
    const service = new TunnelService(
      connection.service,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    for (let index = 0; index < 5; index++) {
      const tunnel = await service.start(
        {
          connectionId: randomUUID(),
          profile: {
            name: `local-${index}`,
            hostId: randomUUID(),
            type: 'local',
            bindHost: '127.0.0.1',
            bindPort: 0,
            targetHost: '127.0.0.1',
            targetPort: 22,
            allowNonLoopback: false,
          },
        },
        randomUUID(),
      );
      expect(tunnel.state).toBe('active');
      expect(tunnel.bindPort).toBeGreaterThan(0);
      await service.close(tunnel.id);
    }
    expect(service.resourceCount()).toBe(0);
    await service.closeAll();
    database.close();
  });

  it('keeps an inspectable failure after the SSH owner closes and releases it on stop', async () => {
    const database = await ProductDatabase.open();
    const connection = fakeConnections();
    const service = new TunnelService(
      connection.service,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    const tunnel = await service.start(
      {
        connectionId: randomUUID(),
        profile: {
          name: 'owner-close',
          hostId: randomUUID(),
          type: 'local',
          bindHost: '127.0.0.1',
          bindPort: 0,
          targetHost: '127.0.0.1',
          targetPort: 22,
          allowNonLoopback: false,
        },
      },
      randomUUID(),
    );
    connection.close(new Error('network lost'));
    await vi.waitFor(() =>
      expect(service.list()).toContainEqual(
        expect.objectContaining({
          id: tunnel.id,
          state: 'failed',
          errorCode: 'SSH_CONNECTION_CLOSED',
        }),
      ),
    );
    await service.close(tunnel.id);
    expect(service.resourceCount()).toBe(0);
    database.close();
  });

  it('maps a port collision to a typed, inspectable failure', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const database = await ProductDatabase.open();
    const connection = fakeConnections();
    const service = new TunnelService(
      connection.service,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    try {
      await expect(
        service.start(
          {
            connectionId: randomUUID(),
            profile: {
              name: 'collision',
              hostId: randomUUID(),
              type: 'local',
              bindHost: '127.0.0.1',
              bindPort: address.port,
              targetHost: '127.0.0.1',
              targetPort: 22,
              allowNonLoopback: false,
            },
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(service.list()).toContainEqual(
        expect.objectContaining({ state: 'failed', errorCode: 'TUNNEL_PORT_IN_USE' }),
      );
      expect(connection.listenerCount()).toBe(0);
      await service.closeAll();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      database.close();
    }
  });

  it('rejects non-loopback local binding without explicit opt-in', async () => {
    const database = await ProductDatabase.open();
    const service = new TunnelService(
      {} as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    await expect(
      service.start(
        {
          connectionId: randomUUID(),
          profile: {
            name: 'unsafe',
            hostId: randomUUID(),
            type: 'dynamic',
            bindHost: '0.0.0.0',
            bindPort: 0,
            targetHost: null,
            targetPort: null,
            allowNonLoopback: false,
          },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(service.resourceCount()).toBe(0);
    database.close();
  });
});

function fakeConnections() {
  const listeners = new Set<(error?: Error) => void>();
  return {
    service: {
      handle: () => ({
        onClose: (listener: (error?: Error) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    } as never,
    close(error?: Error) {
      for (const listener of [...listeners]) listener(error);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}
