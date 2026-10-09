import type {
  ConnectionHistoryItem,
  ConnectionHistoryPage,
  ConnectionHistorySort,
} from '@workspace/contracts';
import { BookmarkPlus, Clock3, Trash2 } from 'lucide-react';
import {
  connectionHistoryFrequency,
  connectionHistoryRelativeTime,
  connectionHistoryTarget,
} from './history-model';
import './history-panel.css';
import { useI18n } from '../../i18n/context';

export function HistoryPanel({
  page,
  selectedSort,
  enabled,
  busy = false,
  hideAddresses = false,
  onSort,
  onReconnect,
  onPromote,
  onDelete,
  onClear,
  onLoadMore,
  onSetEnabled,
  error,
  onRetry,
  notice,
  onDismissNotice,
}: {
  page: ConnectionHistoryPage | undefined;
  selectedSort?: ConnectionHistorySort;
  enabled: boolean;
  busy?: boolean;
  hideAddresses?: boolean;
  onSort(sort: ConnectionHistorySort): void;
  onReconnect(item: ConnectionHistoryItem): void;
  onPromote(item: ConnectionHistoryItem): void;
  onDelete(item: ConnectionHistoryItem): void;
  onClear(): void;
  onLoadMore?(): void;
  onSetEnabled?(enabled: boolean): void;
  error?: string;
  onRetry?(): void;
  notice?: string;
  onDismissNotice?(): void;
}) {
  const { x } = useI18n();
  const sort = selectedSort ?? page?.sort ?? 'recent';
  const items = enabled ? (page?.items ?? []) : [];
  return (
    <section className="connection-history-panel" aria-label={x('history.title')}>
      <header className="connection-history-toolbar">
        <label className="connection-history-sort">
          <input
            type="checkbox"
            role="switch"
            aria-label={x('history.sortByFrequency')}
            checked={sort === 'frequency'}
            disabled={busy}
            onChange={(event) => onSort(event.currentTarget.checked ? 'frequency' : 'recent')}
          />
          <span>{x('history.sortByFrequency')}</span>
        </label>
        <div className="connection-history-toolbar-actions">
          {onSetEnabled && (
            <label className="connection-history-recording">
              <input
                type="checkbox"
                aria-label={x('history.record')}
                checked={enabled}
                disabled={busy}
                onChange={(event) => onSetEnabled(event.currentTarget.checked)}
              />
              <span>{x('history.recordShort')}</span>
            </label>
          )}
          <button
            className="connection-history-clear"
            aria-label={x('history.clear')}
            title={x('history.clearShort')}
            disabled={busy || !items.length}
            onClick={onClear}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      <div className="connection-history-body">
        {notice && (
          <div className="connection-history-notice" role="alert">
            <span>{notice}</span>
            {onDismissNotice && (
              <button aria-label={x('history.closeNotice')} onClick={onDismissNotice}>
                ×
              </button>
            )}
          </div>
        )}
        {error ? (
          <div className="connection-history-empty connection-history-error" role="alert">
            <span>{error}</span>
            {onRetry && <button onClick={onRetry}>{x('history.retry')}</button>}
          </div>
        ) : !enabled ? (
          <div className="connection-history-empty">
            <Clock3 size={20} />
            <span>{x('history.disabled')}</span>
            {onSetEnabled && (
              <button onClick={() => onSetEnabled(true)}>{x('history.enable')}</button>
            )}
          </div>
        ) : !page ? (
          <div className="connection-history-empty" aria-live="polite">
            {x('history.loading')}
          </div>
        ) : !items.length ? (
          <div className="connection-history-empty">
            <Clock3 size={20} />
            <span>{x('history.empty')}</span>
          </div>
        ) : (
          <div className="connection-history-list">
            {items.map((item) => (
              <article className="connection-history-row" key={item.id}>
                <button
                  className="connection-history-main"
                  disabled={busy}
                  title={x('history.reconnectTarget', {
                    target: connectionHistoryTarget(item, hideAddresses),
                  })}
                  onClick={() => onReconnect(item)}
                >
                  <span className="connection-history-name">{item.name}</span>
                  <span className="connection-history-separator" aria-hidden="true">
                    {' '}
                    -{' '}
                  </span>
                  <span className="connection-history-target">
                    {connectionHistoryTarget(item, hideAddresses)}
                  </span>
                  <span className="connection-history-meta">
                    {connectionHistoryFrequency(item, x)} ·{' '}
                    {connectionHistoryRelativeTime(item.lastConnectedAt, x)}
                  </span>
                </button>
                <div className="connection-history-actions">
                  <button
                    aria-label={x('history.saveNamedBookmark', { name: item.name })}
                    title={x('history.saveAsBookmark')}
                    disabled={busy}
                    onClick={() => onPromote(item)}
                  >
                    <BookmarkPlus size={13} />
                  </button>
                  <button
                    aria-label={x('history.deleteNamed', { name: item.name })}
                    title={x('history.delete')}
                    disabled={busy}
                    onClick={() => onDelete(item)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </article>
            ))}
            {page.nextCursor && onLoadMore && (
              <button className="connection-history-more" disabled={busy} onClick={onLoadMore}>
                {x('history.loadMore')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
