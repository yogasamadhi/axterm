import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  BookmarkTree,
  Connection,
  ConnectionHistoryItem,
  Settings,
} from '../../packages/contracts/src/index';
import {
  clearHistory,
  deleteHistoryItem,
  historyReconnectRequirement,
  promoteHistoryItem,
  reconnectHistoryItem,
  setConnectionHistoryEnabled,
  type ConnectionHistoryClient,
  type ConnectionHistoryQueryCache,
} from '../../apps/desktop/src/renderer/src/app/history/history-actions';

const now = '2026-09-12T00:00:00.000Z';

function historyItem(): ConnectionHistoryItem {
  return {
    id: randomUUID(),
    hostId: randomUUID(),
    name: 'Production',
    hostname: 'prod.example',
    port: 22,
    username: 'operator',
    authType: 'agent',
    jumpHostId: null,
    connectionOptions: {
      connectionTimeoutMs: 50_000,
      keepaliveIntervalMs: 10_000,
      keepaliveCountMax: 10,
      compression: true,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      reconnectPolicy: { mode: 'manual', delayMs: 3_000, maxAttempts: 10 },
    },
    count: 2,
    lastConnectedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 2,
  };
}

function connection(hostId: string): Connection {
  return {
    id: randomUUID(),
    hostId,
    state: 'connecting',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function queryFixture() {
  const invalidations: unknown[][] = [];
  const cache = new Map<string, unknown>();
  const queryClient: ConnectionHistoryQueryCache = {
    invalidateQueries: vi.fn(async (options) => {
      invalidations.push([...options.queryKey]);
    }),
    setQueryData: vi.fn((queryKey, value) => cache.set(JSON.stringify(queryKey), value)),
  };
  return { queryClient, invalidations, cache };
}

describe('connection history desktop actions', () => {
  it('requires a one-time secret only for transient password flows and guides transient keys', () => {
    const saved = historyItem();
    expect(historyReconnectRequirement({ ...saved, authType: 'password' })).toBe('direct');
    expect(historyReconnectRequirement({ ...saved, hostId: null, authType: 'password' })).toBe(
      'one-time-secret',
    );
    expect(
      historyReconnectRequirement({ ...saved, hostId: null, authType: 'keyboardInteractive' }),
    ).toBe('one-time-secret');
    expect(historyReconnectRequirement({ ...saved, hostId: null, authType: 'privateKey' })).toBe(
      'configure-private-key',
    );
    expect(historyReconnectRequirement({ ...saved, hostId: null, authType: 'agent' })).toBe(
      'direct',
    );
  });

  it('opens a reconnect result and refreshes both history and live connections', async () => {
    const item = historyItem();
    const pending = connection(item.hostId!);
    const reconnectConnectionHistory = vi.fn().mockResolvedValue({
      historyItem: item,
      connection: pending,
    });
    const client = { reconnectConnectionHistory } as unknown as ConnectionHistoryClient;
    const { queryClient, invalidations } = queryFixture();
    const onStarted = vi.fn().mockResolvedValue(undefined);

    await reconnectHistoryItem(client, queryClient, item, onStarted);

    expect(reconnectConnectionHistory).toHaveBeenCalledWith(item);
    expect(onStarted).toHaveBeenCalledWith(item, pending);
    expect(invalidations).toEqual(
      expect.arrayContaining([['connection-history'], ['connections']]),
    );

    const transient = { ...item, hostId: null, authType: 'password' as const };
    reconnectConnectionHistory.mockResolvedValue({ historyItem: transient, connection: pending });
    await reconnectHistoryItem(client, queryClient, transient, onStarted, 'one-use-secret');
    expect(reconnectConnectionHistory).toHaveBeenLastCalledWith(transient, 'one-use-secret');
  });

  it('publishes the returned tree and refreshes history, bookmarks and hosts after promotion', async () => {
    const item = historyItem();
    const tree: BookmarkTree = {
      revision: 1,
      etag: '"bookmark-tree-v1"',
      groups: [],
      bookmarks: [],
    };
    const nextTree = { ...tree, revision: 2, etag: '"bookmark-tree-v2"' };
    const promoteConnectionHistory = vi.fn().mockResolvedValue({ tree: nextTree });
    const client = { promoteConnectionHistory } as unknown as ConnectionHistoryClient;
    const { queryClient, invalidations, cache } = queryFixture();

    await promoteHistoryItem(client, queryClient, item, tree);

    expect(promoteConnectionHistory).toHaveBeenCalledWith(item, tree, { title: item.name });
    expect(cache.get(JSON.stringify(['bookmark-tree']))).toEqual(nextTree);
    expect(invalidations).toEqual(
      expect.arrayContaining([['connection-history'], ['bookmark-tree'], ['hosts']]),
    );
  });

  it('refreshes history after deleting one row or clearing the collection', async () => {
    const item = historyItem();
    const deleteConnectionHistory = vi.fn().mockResolvedValue({ id: item.id });
    const clearConnectionHistory = vi.fn().mockResolvedValue({ deletedCount: 1 });
    const client = {
      deleteConnectionHistory,
      clearConnectionHistory,
    } as unknown as ConnectionHistoryClient;
    const { queryClient, invalidations } = queryFixture();

    await deleteHistoryItem(client, queryClient, item);
    await clearHistory(client, queryClient, { etag: '"connection-history-v2"' });

    expect(deleteConnectionHistory).toHaveBeenCalledWith(item);
    expect(clearConnectionHistory).toHaveBeenCalledWith({ etag: '"connection-history-v2"' });
    expect(invalidations).toEqual([['connection-history'], ['connection-history']]);
  });

  it('updates the privacy setting and refreshes both settings and history', async () => {
    const settings = {
      privacy: { connectionHistoryEnabled: true },
      version: 3,
    } as unknown as Settings;
    const updated = {
      ...settings,
      privacy: { connectionHistoryEnabled: false },
      version: 4,
    };
    const updateSettings = vi.fn().mockResolvedValue(updated);
    const client = { updateSettings } as unknown as ConnectionHistoryClient;
    const { queryClient, invalidations, cache } = queryFixture();

    await setConnectionHistoryEnabled(client, queryClient, settings, false);

    expect(updateSettings).toHaveBeenCalledWith(settings, {
      privacy: { connectionHistoryEnabled: false },
    });
    expect(cache.get(JSON.stringify(['settings']))).toEqual(updated);
    expect(invalidations).toEqual(expect.arrayContaining([['settings'], ['connection-history']]));
  });
});
