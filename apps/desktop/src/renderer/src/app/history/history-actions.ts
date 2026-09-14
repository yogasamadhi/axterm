import type { createRuntimeClient } from '@workspace/client';
import type {
  BookmarkTree,
  Connection,
  ConnectionHistoryItem,
  ConnectionHistorySort,
  Settings,
} from '@workspace/contracts';

export type ConnectionHistoryClient = ReturnType<typeof createRuntimeClient>;
export interface ConnectionHistoryQueryCache {
  invalidateQueries(options: { queryKey: readonly unknown[] }): Promise<unknown>;
  setQueryData(queryKey: readonly unknown[], value: unknown): unknown;
}

export const connectionHistoryQueryKey = (sort?: ConnectionHistorySort) =>
  sort ? (['connection-history', sort] as const) : (['connection-history'] as const);

export type HistoryReconnectRequirement = 'direct' | 'one-time-secret' | 'configure-private-key';

export function historyReconnectRequirement(
  item: ConnectionHistoryItem,
): HistoryReconnectRequirement {
  if (item.hostId) return 'direct';
  if (item.authType === 'password' || item.authType === 'keyboardInteractive')
    return 'one-time-secret';
  if (item.authType === 'privateKey') return 'configure-private-key';
  return 'direct';
}

export async function reconnectHistoryItem(
  client: ConnectionHistoryClient,
  queryClient: ConnectionHistoryQueryCache,
  item: ConnectionHistoryItem,
  onStarted: (item: ConnectionHistoryItem, connection: Connection) => Promise<void>,
  temporarySecret?: string,
) {
  const result = temporarySecret
    ? await client.reconnectConnectionHistory(item, temporarySecret)
    : await client.reconnectConnectionHistory(item);
  try {
    await onStarted(result.historyItem, result.connection);
  } finally {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: connectionHistoryQueryKey() }),
      queryClient.invalidateQueries({ queryKey: ['connections'] }),
    ]);
  }
  return result;
}

export async function promoteHistoryItem(
  client: ConnectionHistoryClient,
  queryClient: ConnectionHistoryQueryCache,
  item: ConnectionHistoryItem,
  tree: BookmarkTree,
) {
  const result = await client.promoteConnectionHistory(item, tree, { title: item.name });
  queryClient.setQueryData(['bookmark-tree'], result.tree);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: connectionHistoryQueryKey() }),
    queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }),
    queryClient.invalidateQueries({ queryKey: ['hosts'] }),
  ]);
  return result;
}

export async function deleteHistoryItem(
  client: ConnectionHistoryClient,
  queryClient: ConnectionHistoryQueryCache,
  item: ConnectionHistoryItem,
) {
  const result = await client.deleteConnectionHistory(item);
  await queryClient.invalidateQueries({ queryKey: connectionHistoryQueryKey() });
  return result;
}

export async function clearHistory(
  client: ConnectionHistoryClient,
  queryClient: ConnectionHistoryQueryCache,
  state: { etag: string },
) {
  const result = await client.clearConnectionHistory(state);
  await queryClient.invalidateQueries({ queryKey: connectionHistoryQueryKey() });
  return result;
}

export async function setConnectionHistoryEnabled(
  client: ConnectionHistoryClient,
  queryClient: ConnectionHistoryQueryCache,
  settings: Settings,
  enabled: boolean,
) {
  const result = await client.updateSettings(settings, {
    privacy: { connectionHistoryEnabled: enabled },
  });
  queryClient.setQueryData(['settings'], result);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['settings'] }),
    queryClient.invalidateQueries({ queryKey: connectionHistoryQueryKey() }),
  ]);
  return result;
}
