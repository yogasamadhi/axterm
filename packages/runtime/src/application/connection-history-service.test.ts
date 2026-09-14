import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_STARTUP,
  type Connection,
  type Host,
} from '@workspace/contracts';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionHistoryRepository } from '../adapters/sqlite/connection-history-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import type { SshConnectionHandle, SshTransport } from '../ports/ssh-transport';
import type { ConnectionStarter } from '../ports/connection-history';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionHistoryService } from './connection-history-service';
import { ConnectionService } from './connection-service';
import { InteractionService } from './interaction-service';
import { RealtimeHub } from './realtime-hub';
import { TerminalService } from './terminal-service';

function transientHost(name: string, hostname: string): Host {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    groupId: null,
    name,
    hostname,
    port: 22,
    username: 'operator',
    authType: 'agent',
    credentialRef: null,
    passphraseCredentialRef: null,
    certificateCredentialRef: null,
    jumpHostId: null,
    jumpHostIds: [],
    favorite: false,
    proxy: { mode: 'inherit' },
    connectionOptions: structuredClone(DEFAULT_SSH_CONNECTION_OPTIONS),
    startup: structuredClone(DEFAULT_SSH_STARTUP),
    x11: { enabled: false, display: null },
    sshAgent: { enabled: true, path: null },
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

async function fixture() {
  const database = await ProductDatabase.open();
  const hosts = new ProductRepository(database);
  const historyRepository = new ConnectionHistoryRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const history = new ConnectionHistoryService(database, historyRepository, hosts, bookmarks);
  return { database, hosts, historyRepository, bookmarks, history };
}

const connectionResult = (): Connection => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    hostId: randomUUID(),
    state: 'created',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: now,
    updatedAt: now,
  };
};

describe('ConnectionHistoryService', () => {
  it('atomically promotes a transient item, increments each aggregate once and replays idempotently', async () => {
    const context = await fixture();
    try {
      const item = context.historyRepository.record({
        host: transientHost('Production', 'production.example'),
        persistedHostId: null,
      });
      const beforeHistory = context.historyRepository.state();
      const beforeTree = context.bookmarks.snapshot();
      const key = randomUUID();
      const result = context.history.promote(
        item.id,
        { groupId: null, title: 'Production SSH' },
        etagFor(item.version),
        beforeTree.etag,
        key,
      );

      expect(result).toMatchObject({
        createdHost: true,
        historyItem: { id: item.id, hostId: result.host.id, version: 2 },
        bookmark: { hostId: result.host.id, title: 'Production SSH', protocol: 'ssh' },
        history: { revision: beforeHistory.revision + 1 },
        tree: { revision: beforeTree.revision + 1 },
      });
      expect(context.hosts.listHosts()).toHaveLength(1);
      expect(
        context.history.promote(
          item.id,
          { groupId: null, title: 'Production SSH' },
          etagFor(item.version),
          beforeTree.etag,
          key,
        ),
      ).toEqual(result);
      expect(context.hosts.listHosts()).toHaveLength(1);
      expect(context.bookmarks.snapshot().bookmarks).toHaveLength(1);
    } finally {
      context.database.close();
    }
  });

  it('rolls Host, history link, Bookmark, revisions, events and idempotency back on a late failure', async () => {
    const context = await fixture();
    try {
      const item = context.historyRepository.record({
        host: transientHost('Rollback', 'rollback.example'),
        persistedHostId: null,
      });
      const historyBefore = context.historyRepository.state();
      const treeBefore = context.bookmarks.snapshot();
      const eventsBefore = context.hosts.listEvents().length;
      context.database.run(`
        CREATE TRIGGER fail_history_promotion
        BEFORE INSERT ON idempotency_records
        WHEN NEW.operation = 'connection-history.promote'
        BEGIN
          SELECT RAISE(ABORT, 'forced late failure');
        END
      `);

      expect(() =>
        context.history.promote(item.id, {}, etagFor(item.version), treeBefore.etag, randomUUID()),
      ).toThrow();
      expect(context.hosts.listHosts()).toEqual([]);
      expect(context.bookmarks.snapshot()).toEqual(treeBefore);
      expect(context.historyRepository.get(item.id)).toEqual(item);
      expect(context.historyRepository.state()).toEqual(historyBefore);
      expect(context.hosts.listEvents()).toHaveLength(eventsBefore);
      expect(
        context.database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='connection-history.promote'",
        )?.count,
      ).toBe(0);
    } finally {
      context.database.close();
    }
  });

  it('reuses saved jump targets, rejects stale item/tree versions and validates groups', async () => {
    const context = await fixture();
    try {
      const jump = context.hosts.createHost({
        name: 'Jump',
        hostname: 'jump.example',
        username: 'jump-user',
        authType: 'agent',
      });
      const target = context.hosts.createHost({
        name: 'Target',
        hostname: 'target.example',
        username: 'operator',
        authType: 'agent',
        jumpHostId: jump.id,
      });
      const item = context.historyRepository.record({ host: target, persistedHostId: target.id });
      const tree = context.bookmarks.snapshot();

      expect(() =>
        context.history.promote(
          item.id,
          { groupId: randomUUID() },
          etagFor(item.version),
          tree.etag,
          randomUUID(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
      expect(() =>
        context.history.promote(item.id, {}, etagFor(99), tree.etag, randomUUID()),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
      expect(() =>
        context.history.promote(
          item.id,
          {},
          etagFor(item.version),
          '"bookmark-tree-v99"',
          randomUUID(),
        ),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));

      const result = context.history.promote(
        item.id,
        {},
        etagFor(item.version),
        tree.etag,
        randomUUID(),
      );
      expect(result).toMatchObject({
        createdHost: false,
        host: { id: target.id, jumpHostId: jump.id },
      });
      expect(context.hosts.listHosts()).toHaveLength(2);
      expect(result.history).toEqual(context.historyRepository.state());
    } finally {
      context.database.close();
    }
  });

  it('makes delete and clear retry-safe while enforcing row and collection ETags', async () => {
    const context = await fixture();
    try {
      const first = context.historyRepository.record({
        host: transientHost('First', 'first.example'),
        persistedHostId: null,
      });
      context.historyRepository.record({
        host: transientHost('Second', 'second.example'),
        persistedHostId: null,
      });
      expect(() => context.history.delete(first.id, etagFor(99), randomUUID())).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
      );

      const deleteKey = randomUUID();
      const deleted = context.history.delete(first.id, etagFor(first.version), deleteKey);
      expect(context.history.delete(first.id, etagFor(first.version), deleteKey)).toEqual(deleted);
      const state = context.historyRepository.state();
      expect(() => context.history.clear('"connection-history-v1"', randomUUID())).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
      );
      const clearKey = randomUUID();
      const cleared = context.history.clear(state.etag, clearKey);
      expect(cleared.deletedCount).toBe(1);
      expect(context.history.clear(state.etag, clearKey)).toEqual(cleared);
      expect(context.history.list().items).toEqual([]);
    } finally {
      context.database.close();
    }
  });

  it('defaults metadata history on, clears it when disabled and blocks later writes', async () => {
    const context = await fixture();
    try {
      expect(context.hosts.getSettings().privacy.connectionHistoryEnabled).toBe(true);
      context.history.recordSuccessful({
        host: transientHost('Before disable', 'before.example'),
        persistedHostId: null,
      });
      expect(context.history.list().total).toBe(1);
      const settings = context.hosts.getSettings();
      context.hosts.updateSettings(
        { privacy: { connectionHistoryEnabled: false } },
        etagFor(settings.version),
      );
      expect(context.history.list().items).toEqual([]);
      context.history.recordSuccessful({
        host: transientHost('After disable', 'after.example'),
        persistedHostId: null,
      });
      expect(context.history.list().items).toEqual([]);
      expect(context.hosts.listEvents().at(-2)?.type).toBe('connection-history.cleared');
      expect(context.hosts.listEvents().at(-1)?.type).toBe('settings.updated');
    } finally {
      context.database.close();
    }
  });

  it('reconnects from the safe snapshot or authoritative saved Host after an item ETag check', async () => {
    const context = await fixture();
    try {
      const quick = context.historyRepository.record({
        host: transientHost('Quick', 'quick.example'),
        persistedHostId: null,
      });
      const create = vi.fn(() => connectionResult());
      const quickResult = context.history.reconnect(
        quick.id,
        { temporarySecret: 'one-use-only' },
        etagFor(quick.version),
        'quick-reconnect',
        { create } as ConnectionStarter,
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ hostname: 'quick.example', username: 'operator' }),
          temporarySecret: 'one-use-only',
        }),
      );
      expect(quickResult.historyItem.id).toBe(quick.id);
      expect(
        context.history.reconnect(
          quick.id,
          { temporarySecret: 'one-use-only' },
          etagFor(quick.version),
          'quick-reconnect',
          { create } as ConnectionStarter,
        ),
      ).toEqual(quickResult);
      expect(create).toHaveBeenCalledTimes(1);
      expect(() =>
        context.history.reconnect(
          quick.id,
          { temporarySecret: 'changed' },
          etagFor(quick.version),
          'quick-reconnect',
          { create } as ConnectionStarter,
        ),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

      const saved = context.hosts.createHost({
        name: 'Saved',
        hostname: 'saved.example',
        username: 'operator',
        authType: 'agent',
      });
      const savedItem = context.historyRepository.record({
        host: saved,
        persistedHostId: saved.id,
      });
      context.history.reconnect(savedItem.id, {}, etagFor(savedItem.version), 'saved-reconnect', {
        create,
      } as ConnectionStarter);
      expect(create).toHaveBeenLastCalledWith({ hostId: saved.id });
      expect(() =>
        context.history.reconnect(savedItem.id, {}, etagFor(99), 'stale-reconnect', {
          create,
        } as ConnectionStarter),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
    } finally {
      context.database.close();
    }
  });
});

describe('ConnectionService history recording', () => {
  it('records only a first successful ready state per live connection and never persists a secret', async () => {
    const context = await fixture();
    const closeListeners = new Set<(error?: Error) => void>();
    const sshHandle: SshConnectionHandle = {
      id: randomUUID(),
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      async openShell() {
        throw new Error('unused');
      },
      async openSftp() {
        throw new Error('unused');
      },
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async forwardOut() {
        throw new Error('unused');
      },
      async forwardIn() {
        return 0;
      },
      async unforwardIn() {},
      async close() {
        closeListeners.clear();
      },
    };
    const transport: SshTransport = { connect: vi.fn(async () => sshHandle) };
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      context.history,
    );
    try {
      const input = {
        target: {
          name: 'Quick',
          hostname: 'quick.example',
          port: 22,
          username: 'operator',
          authType: 'password' as const,
        },
        temporarySecret: 'never-store-this-password',
      };
      const first = connections.create(input);
      await vi.waitFor(() => expect(connections.get(first.id).state).toBe('ready'));
      const second = connections.create(input);
      await vi.waitFor(() => expect(connections.get(second.id).state).toBe('ready'));
      expect(context.history.list().items[0]).toMatchObject({
        hostname: 'quick.example',
        count: 2,
      });
      expect(JSON.stringify(context.history.list())).not.toContain('never-store-this-password');
    } finally {
      await connections.closeAll();
      interactions.close();
      realtime.close();
      context.database.close();
    }
  });

  it('does not record a connection that never reaches ready', async () => {
    const context = await fixture();
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      {
        connect: async () => {
          throw new Error('offline');
        },
      },
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      context.history,
    );
    try {
      const connection = connections.create({
        target: { hostname: 'offline.example', username: 'operator', authType: 'agent' },
      });
      await vi.waitFor(() => expect(connections.get(connection.id).state).toBe('failed'));
      expect(context.history.list().items).toEqual([]);
    } finally {
      await connections.closeAll();
      interactions.close();
      realtime.close();
      context.database.close();
    }
  });

  it('does not count transport recovery as a second user connection', async () => {
    vi.useFakeTimers();
    const context = await fixture();
    const controls: Array<{ disconnect(): void }> = [];
    const transport: SshTransport = {
      async connect() {
        const listeners = new Set<(error?: Error) => void>();
        controls.push({
          disconnect() {
            for (const listener of [...listeners]) listener(new Error('network lost'));
          },
        });
        return {
          id: randomUUID(),
          onClose(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async openShell() {
            throw new Error('unused');
          },
          async openSftp() {
            throw new Error('unused');
          },
          async exec() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          async forwardOut() {
            throw new Error('unused');
          },
          async forwardIn() {
            return 0;
          },
          async unforwardIn() {},
          async close() {
            listeners.clear();
          },
        };
      },
    };
    const host = context.hosts.createHost({
      name: 'Recovering',
      hostname: 'recovering.example',
      username: 'operator',
      authType: 'agent',
      connectionOptions: {
        reconnectPolicy: { mode: 'automatic', delayMs: 250, maxAttempts: 2 },
      },
    });
    const realtime = new RealtimeHub();
    const interactions = new InteractionService(realtime);
    const connections = new ConnectionService(
      context.hosts,
      transport,
      undefined,
      interactions,
      realtime,
      new TerminalService({
        open: () => {
          throw new Error('unused');
        },
      }),
      context.history,
    );
    try {
      const connection = connections.create({ hostId: host.id });
      await vi.advanceTimersByTimeAsync(0);
      expect(connections.get(connection.id).state).toBe('ready');
      expect(context.history.list().items[0]?.count).toBe(1);
      controls[0]!.disconnect();
      await vi.advanceTimersByTimeAsync(250);
      expect(connections.get(connection.id).state).toBe('ready');
      expect(controls).toHaveLength(2);
      expect(context.history.list().items[0]?.count).toBe(1);
    } finally {
      await connections.closeAll();
      interactions.close();
      realtime.close();
      context.database.close();
      vi.useRealTimers();
    }
  });
});
