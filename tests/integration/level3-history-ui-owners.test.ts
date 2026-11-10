import { expect, it, vi } from 'vitest';
import {
  connectionHistoryItemSchema,
  connectionHistoryPageSchema,
  type ConnectionHistoryPage,
} from '@axterm/plugin-api/catalog';
import type { CatalogState } from '../../packages/plugins/catalog/src/client/index.ts';
import { HistoryView } from '../../packages/plugins/catalog/src/client/ui/history-view.ts';
import { HistoryActions } from '../../packages/plugins/catalog/src/client/ui/history-actions.ts';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
const page = (revision = 1, sort: 'recent' | 'frequency' = 'recent') =>
  connectionHistoryPageSchema.parse({
    revision,
    etag: '"connection-history-v' + revision + '"',
    sort,
    limit: 25,
    total: 0,
    items: [],
    nextCursor: null,
  });
function fixture() {
  const generation = crypto.randomUUID();
  let state = {
    status: 'ready',
    baseline: { generation, history: page(), bookmarks: { etag: '"bookmark-tree-v1"' } },
  } as CatalogState;
  const listeners = new Set<() => void>();
  const model = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    listConnectionHistory: vi.fn(
      async (_generation: string, _query: unknown): Promise<ConnectionHistoryPage> => page(),
    ),
    promoteConnectionHistoryToBookmark: vi.fn(
      async (..._args: unknown[]) => ({ ids: [] }) as never,
    ),
    deleteConnectionHistory: vi.fn(async (..._args: unknown[]) => ({ ids: [] }) as never),
    clearConnectionHistory: vi.fn(async (..._args: unknown[]) => ({ ids: [] }) as never),
  };
  return {
    generation,
    model,
    listeners,
    publish(value: CatalogState) {
      state = value;
      for (const fn of listeners) fn();
    },
  };
}
it('joins an obsolete selected read, coalesces query replacement and withdraws facts on generation change', async () => {
  const f = fixture();
  const first = Promise.withResolvers<ConnectionHistoryPage>();
  f.model.listConnectionHistory
    .mockImplementationOnce(() => first.promise)
    .mockImplementation(async () => page(1, 'frequency'));
  const view = new HistoryView(f.model);
  await Promise.resolve();
  view.sort('frequency');
  expect(f.model.listConnectionHistory).toHaveBeenCalledTimes(1);
  first.resolve(page());
  await vi.waitFor(() => expect(view.getSnapshot().page?.sort).toBe('frequency'));
  expect(f.model.listConnectionHistory).toHaveBeenCalledTimes(2);
  const replacement = Promise.withResolvers<ConnectionHistoryPage>();
  f.model.listConnectionHistory.mockImplementation(() => replacement.promise);
  const nextGeneration = crypto.randomUUID();
  f.publish({
    status: 'ready',
    baseline: { generation: nextGeneration, history: page() },
  } as CatalogState);
  expect(view.getSnapshot().page).toBeUndefined();
  await Promise.resolve();
  expect(f.model.listConnectionHistory.mock.calls.at(-1)?.[0]).toBe(nextGeneration);
  let stopped = false;
  const stop = view.dispose().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  replacement.resolve(page());
  await stop;
  expect(view.getSnapshot().page).toBeUndefined();
  expect(f.listeners.size).toBe(0);
});
it('does not retry a failed page automatically and joins a late rejected read on unload', async () => {
  const f = fixture();
  f.model.listConnectionHistory.mockRejectedValue(new Error('Read unavailable'));
  const view = new HistoryView(f.model);
  await vi.waitFor(() => expect(view.getSnapshot().failed).toBe(true));
  expect(f.model.listConnectionHistory).toHaveBeenCalledTimes(1);
  view.retry();
  await vi.waitFor(() => expect(f.model.listConnectionHistory).toHaveBeenCalledTimes(2));
  await view.dispose();
});
const item = () =>
  connectionHistoryItemSchema.parse({
    id: crypto.randomUUID(),
    hostId: null,
    name: 'History fixture',
    hostname: '127.0.0.1',
    port: 22,
    username: 'fixture',
    authType: 'password',
    jumpHostId: null,
    connectionOptions: {},
    count: 1,
    version: 1,
    lastConnectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
const settings = {
  getSnapshot: () => ({ status: 'connecting' }),
  subscribe: () => () => {},
  retry: async () => {},
  setConnectionHistoryEnabled: async () => {
    throw new Error('Unexpected setting write');
  },
} as Pick<ConfigurationClientActions, 'getSnapshot' | 'setConnectionHistoryEnabled'>;
it('keeps exact promotion identity/payload/revisions after an uncertain response and only explicitly retries the same command', async () => {
  const f = fixture();
  f.model.promoteConnectionHistoryToBookmark.mockRejectedValueOnce(
    new Error('Lost acknowledgment'),
  );
  const connections = { openSsh: vi.fn(), openHistory: vi.fn() };
  const owner = new HistoryActions(f.model, settings, connections);
  const input = item();
  expect(await owner.promote(input)).toBe(false);
  const original = structuredClone(f.model.promoteConnectionHistoryToBookmark.mock.calls[0]);
  input.name = 'Changed draft';
  expect(owner.getSnapshot().uncertain).toBe(true);
  expect(await owner.remove(input)).toBe(false);
  expect(f.model.deleteConnectionHistory).not.toHaveBeenCalled();
  expect(await owner.retry()).toBe(true);
  expect(f.model.promoteConnectionHistoryToBookmark.mock.calls[1]).toEqual(original);
  expect(connections.openHistory).not.toHaveBeenCalled();
  await owner.dispose();
});
it('fails unknown same-generation drain and does not resubmit work into a replacement Host', async () => {
  const f = fixture();
  f.model.clearConnectionHistory.mockRejectedValue(new Error('Lost acknowledgment'));
  const connections = { openSsh: vi.fn(), openHistory: vi.fn() };
  const owner = new HistoryActions(f.model, settings, connections);
  await owner.clear(page().etag);
  await expect(owner.dispose()).rejects.toThrow('DRAIN_UNCERTAIN');
  expect(f.model.clearConnectionHistory).toHaveBeenCalledTimes(1);
  const next = new HistoryActions(f.model, settings, connections);
  await next.clear(page().etag);
  f.publish({ status: 'ready', baseline: { generation: crypto.randomUUID() } } as CatalogState);
  expect(await next.retry()).toBe(false);
  expect(f.model.clearConnectionHistory).toHaveBeenCalledTimes(2);
  await next.dispose();
});
it('passes one-time authentication once to the owning connection UI and joins its actual cancellation', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<string>();
  const connections = { openSsh: vi.fn(), openHistory: vi.fn(() => pending.promise) };
  const owner = new HistoryActions(f.model, settings, connections);
  const opening = owner.connect(item(), 'TRANSIENT_HISTORY_SECRET');
  await Promise.resolve();
  const signal = (
    connections.openHistory.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      { signal: AbortSignal },
    ]
  )[3].signal;
  let stopped = false;
  const stop = owner.dispose().then(() => {
    stopped = true;
  });
  expect(signal.aborted).toBe(true);
  await Promise.resolve();
  expect(stopped).toBe(false);
  pending.reject(new Error('Canceled actual connection admission'));
  expect(await opening).toBe(false);
  await stop;
  expect(connections.openHistory).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(owner.getSnapshot())).not.toContain('TRANSIENT_HISTORY_SECRET');
});
