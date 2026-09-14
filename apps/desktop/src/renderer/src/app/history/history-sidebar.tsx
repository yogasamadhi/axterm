import { useState } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  BookmarkTree,
  Connection,
  ConnectionHistoryItem,
  ConnectionHistorySort,
  Settings,
} from '@workspace/contracts';
import {
  clearHistory,
  connectionHistoryQueryKey,
  deleteHistoryItem,
  historyReconnectRequirement,
  promoteHistoryItem,
  reconnectHistoryItem,
  setConnectionHistoryEnabled,
  type ConnectionHistoryClient,
} from './history-actions';
import { HistoryPanel } from './history-panel';
import { HistorySecretDialog } from './history-secret-dialog';
import { useI18n } from '../../i18n/context';

export function ConnectionHistorySidebar({
  client,
  queryClient,
  ready,
  bookmarkTree,
  settings,
  onReconnect,
}: {
  client: ConnectionHistoryClient;
  queryClient: QueryClient;
  ready: boolean;
  bookmarkTree: BookmarkTree | undefined;
  settings: Settings | undefined;
  onReconnect(item: ConnectionHistoryItem, connection: Connection): Promise<void>;
}) {
  const { x } = useI18n();
  const [sort, setSort] = useState<ConnectionHistorySort>('recent');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [secretItem, setSecretItem] = useState<ConnectionHistoryItem>();
  const history = useQuery({
    queryKey: connectionHistoryQueryKey(sort),
    queryFn: () => client.connectionHistory({ sort, limit: 50 }),
    enabled: ready,
    retry: false,
  });

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setActionError('');
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : x('history.actionFailed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reconnectWithOneTimeSecret(
    item: ConnectionHistoryItem,
    temporarySecret: string,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setActionError('');
    try {
      await reconnectHistoryItem(client, queryClient, item, onReconnect, temporarySecret);
      return true;
    } finally {
      setBusy(false);
    }
  }

  const currentSettings = () => queryClient.getQueryData<Settings>(['settings']) ?? settings;
  const currentTree = () =>
    queryClient.getQueryData<BookmarkTree>(['bookmark-tree']) ?? bookmarkTree;

  return (
    <>
      <HistoryPanel
        page={history.data}
        selectedSort={sort}
        enabled={settings?.privacy.connectionHistoryEnabled ?? true}
        hideAddresses={settings?.privacy.hideAddresses ?? false}
        busy={busy || history.isFetching}
        error={
          history.error instanceof Error
            ? history.error.message
            : history.isError
              ? x('history.loadFailed')
              : ''
        }
        notice={actionError}
        onDismissNotice={() => setActionError('')}
        onRetry={() => {
          setActionError('');
          void history.refetch();
        }}
        onSort={setSort}
        onReconnect={(item) => {
          const requirement = historyReconnectRequirement(item);
          if (requirement === 'one-time-secret') {
            setActionError('');
            setSecretItem(item);
            return;
          }
          if (requirement === 'configure-private-key') {
            setActionError(x('history.privateKeyMissing'));
            return;
          }
          void run(() => reconnectHistoryItem(client, queryClient, item, onReconnect));
        }}
        onPromote={(item) =>
          void run(async () => {
            const tree = currentTree();
            if (!tree) throw new Error(x('history.bookmarkTreeNotReady'));
            await promoteHistoryItem(client, queryClient, item, tree);
          })
        }
        onDelete={(item) => void run(() => deleteHistoryItem(client, queryClient, item))}
        onClear={() => {
          if (!history.data) return;
          void run(() => clearHistory(client, queryClient, history.data!));
        }}
        onSetEnabled={(enabled) =>
          void run(async () => {
            const value = currentSettings();
            if (!value) throw new Error(x('history.settingsNotReady'));
            await setConnectionHistoryEnabled(client, queryClient, value, enabled);
          })
        }
      />
      {secretItem && (
        <HistorySecretDialog
          item={secretItem}
          onClose={() => setSecretItem(undefined)}
          onSubmit={(temporarySecret) => reconnectWithOneTimeSecret(secretItem, temporarySecret)}
        />
      )}
    </>
  );
}
