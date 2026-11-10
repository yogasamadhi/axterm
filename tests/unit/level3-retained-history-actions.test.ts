import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { connectionHistoryItemSchema } from '@axterm/plugin-api/catalog';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { CatalogState } from '../../packages/plugins/catalog/src/client/index.ts';
import {
  HistoryActions,
  historyReconnectRequirement,
} from '../../packages/plugins/catalog/src/client/ui/history-actions.ts';
function fixture() {
  const generation = randomUUID();
  const item = connectionHistoryItemSchema.parse({
    id: randomUUID(),
    hostId: randomUUID(),
    name: 'Production',
    hostname: 'prod.example',
    port: 22,
    username: 'operator',
    authType: 'agent',
    jumpHostId: null,
    connectionOptions: {
      connectionTimeoutMs: 50000,
      keepaliveIntervalMs: 10000,
      keepaliveCountMax: 10,
      compression: true,
      reconnectPolicy: { mode: 'manual', delayMs: 3000, maxAttempts: 10 },
    },
    count: 2,
    lastConnectedAt: '2026-09-12T00:00:00.000Z',
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    version: 2,
  });
  const model = {
    getSnapshot: () =>
      ({
        status: 'ready',
        baseline: { generation, bookmarks: { etag: '"bookmark-tree-v1"' } },
      }) as CatalogState,
    promoteConnectionHistoryToBookmark: vi.fn(
      async (..._args: unknown[]) => ({ ids: [] }) as never,
    ),
    deleteConnectionHistory: vi.fn(async (..._args: unknown[]) => ({ ids: [] }) as never),
    clearConnectionHistory: vi.fn(async (..._args: unknown[]) => ({ ids: [] }) as never),
  };
  const setting = {
    getSnapshot: () => ({
      status: 'ready',
      baseline: {
        generation,
        settings: { privacy: { connectionHistoryEnabled: true }, version: 3 },
      },
    }),
    setConnectionHistoryEnabled: vi.fn(async (..._args: unknown[]) => ({ ids: [] })),
  };
  const connections = {
    openSsh: vi.fn(),
    openHistory: vi.fn(async (..._args: unknown[]) => 'session-id'),
  };
  const actions = new HistoryActions(
    model,
    setting as unknown as ConfigurationClientActions,
    connections,
  );
  return { item, model, setting, connections, actions };
}
it('retains every saved and transient password, interactive, private-key and agent reconnect requirement', () => {
  const { item: saved } = fixture();
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
  expect(historyReconnectRequirement({ ...saved, hostId: null, authType: 'agent' })).toBe('direct');
});
it('passes saved and one-time reconnect identity and version exactly to the actual connection UI without retaining secrets', async () => {
  const f = fixture();
  try {
    expect(await f.actions.connect(f.item)).toBe(true);
    expect(f.connections.openHistory).toHaveBeenCalledWith(f.item.id, {}, '"v2"', {
      signal: expect.any(AbortSignal),
    });
    const transient = { ...f.item, hostId: null, authType: 'password' as const };
    expect(await f.actions.connect(transient, 'one-use-secret')).toBe(true);
    expect(f.connections.openHistory).toHaveBeenLastCalledWith(
      transient.id,
      { temporarySecret: 'one-use-secret' },
      '"v2"',
      { signal: expect.any(AbortSignal) },
    );
    expect(JSON.stringify(f.actions.getSnapshot())).not.toContain('one-use-secret');
  } finally {
    await f.actions.dispose();
  }
});
it('submits promotion with exact title, row revision and captured bookmark tree revision', async () => {
  const f = fixture();
  try {
    expect(await f.actions.promote(f.item)).toBe(true);
    expect(f.model.promoteConnectionHistoryToBookmark).toHaveBeenCalledWith(
      expect.any(String),
      f.item.id,
      { title: 'Production' },
      '"v2"',
      '"bookmark-tree-v1"',
    );
    expect(f.actions.getSnapshot()).toEqual({ busy: false, failed: false, uncertain: false });
  } finally {
    await f.actions.dispose();
  }
});
it('deletes and clears through distinct receipt identities with the original row and collection preconditions', async () => {
  const f = fixture();
  try {
    expect(await f.actions.remove(f.item)).toBe(true);
    expect(await f.actions.clear('"connection-history-v2"')).toBe(true);
    expect(f.model.deleteConnectionHistory).toHaveBeenCalledWith(
      expect.any(String),
      f.item.id,
      '"v2"',
    );
    expect(f.model.clearConnectionHistory).toHaveBeenCalledWith(
      expect.any(String),
      '"connection-history-v2"',
    );
    expect(f.model.deleteConnectionHistory.mock.calls[0]![0]).not.toBe(
      f.model.clearConnectionHistory.mock.calls[0]![0],
    );
  } finally {
    await f.actions.dispose();
  }
});
it('submits history privacy through the selected Configuration owner and accepted settings revision', async () => {
  const f = fixture();
  try {
    expect(await f.actions.enabled(false)).toBe(true);
    expect(f.setting.setConnectionHistoryEnabled).toHaveBeenCalledWith(
      expect.any(String),
      false,
      '"v3"',
    );
    expect(f.model.clearConnectionHistory).not.toHaveBeenCalled();
  } finally {
    await f.actions.dispose();
  }
});
