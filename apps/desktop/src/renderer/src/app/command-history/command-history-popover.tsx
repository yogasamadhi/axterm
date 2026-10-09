import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { CommandHistoryItem, CommandHistorySort, Settings } from '@workspace/contracts';
import { Check, Copy, History, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../../stores/workspace';
import { useI18n } from '../../i18n/context';
import './command-history-popover.css';

export function CommandHistoryPopover({
  client,
  settings,
  ready,
  activeTerminalId,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  settings: Settings | undefined;
  ready: boolean;
  activeTerminalId: string | undefined;
}) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [settledSearch, setSettledSearch] = useState('');
  const [sort, setSort] = useState<CommandHistorySort>('recent');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const enabled = settings?.privacy.commandHistoryEnabled ?? false;

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledSearch(search.trim()), 120);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const blur = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', blur);
    };
  }, [open]);

  const history = useQuery({
    queryKey: ['command-history', sort, settledSearch],
    queryFn: () =>
      client.commandHistory({
        sort,
        ...(settledSearch ? { search: settledSearch } : {}),
        limit: 200,
      }),
    enabled: open && ready && enabled,
  });

  async function setEnabled(value: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      const next = await client.updateSettings(settings, {
        privacy: { commandHistoryEnabled: value },
      });
      queryClient.setQueryData(['settings'], next);
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
      setFeedback(x(value ? 'commandHistory.enabledNotice' : 'commandHistory.disabledNotice'));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  function insert(item: CommandHistoryItem) {
    if (!activeTerminalId) {
      setFeedback(x('commandHistory.selectTerminal'));
      return;
    }
    useWorkspace.getState().insertTerminal(activeTerminalId, item.command);
    setFeedback(x('commandHistory.inserted'));
    setOpen(false);
  }

  async function copy(item: CommandHistoryItem) {
    try {
      await navigator.clipboard.writeText(item.command);
      setFeedback(x('commandHistory.copied'));
    } catch {
      setFeedback(x('commandHistory.clipboardFailed'));
    }
  }

  async function remove(item: CommandHistoryItem) {
    if (busy) return;
    setBusy(true);
    setFeedback('');
    try {
      await client.deleteCommandHistory(item);
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.deleteFailed'));
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!history.data || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      await client.clearCommandHistory(history.data);
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.clearFailed'));
      await queryClient.invalidateQueries({ queryKey: ['command-history'] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="command-history-root" ref={root}>
      <button
        className={open ? 'status-command-history active' : 'status-command-history'}
        type="button"
        title={x('commandHistory.title')}
        aria-label={x('commandHistory.title')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={13} />
        <span>{x('commandHistory.shortTitle')}</span>
      </button>
      {open && (
        <section className="command-history-popover" aria-label={x('commandHistory.panel')}>
          <div className="command-history-popover-content">
            <div className="command-history-search">
              <div className="command-history-search-field">
                <input
                  autoFocus
                  value={search}
                  maxLength={256}
                  placeholder={x('commandHistory.search')}
                  aria-label={x('commandHistory.searchHistory')}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    aria-label={x('commandHistory.clearSearch')}
                    onClick={() => setSearch('')}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            {!enabled ? (
              <div className="command-history-disabled">
                <History size={22} />
                <strong>{x('commandHistory.offByDefault')}</strong>
                <p>{x('commandHistory.privacyDescription')}</p>
                <button
                  type="button"
                  disabled={!settings || busy}
                  onClick={() => void setEnabled(true)}
                >
                  {x('commandHistory.enable')}
                </button>
              </div>
            ) : (
              <>
                <header className="command-history-header">
                  <label>
                    <input
                      type="checkbox"
                      checked={sort === 'frequency'}
                      onChange={(event) => setSort(event.target.checked ? 'frequency' : 'recent')}
                    />
                    <span className="history-check">
                      {sort === 'frequency' && <Check size={10} />}
                    </span>
                    {x('commandHistory.sortByFrequency')}
                  </label>
                  <button
                    type="button"
                    className="command-history-clear"
                    title={x('commandHistory.clear')}
                    aria-label={x('commandHistory.clear')}
                    disabled={!history.data?.items.length || busy}
                    onClick={() => void clear()}
                  >
                    <Trash2 size={13} />
                  </button>
                </header>
                <div className="command-history-list" aria-live="polite">
                  {history.isLoading && (
                    <p className="command-history-empty">{x('commandHistory.loading')}</p>
                  )}
                  {history.isError && (
                    <p className="command-history-empty">{x('commandHistory.unavailable')}</p>
                  )}
                  {history.data?.items.map((item) => (
                    <div className="command-history-item" key={item.id}>
                      <button
                        type="button"
                        className="command-history-item-text"
                        title={item.command}
                        disabled={!activeTerminalId}
                        onClick={() => insert(item)}
                      >
                        {item.command}
                      </button>
                      <span
                        className="command-history-count"
                        title={x('commandHistory.usedCount', { count: item.count })}
                      >
                        {item.count}
                      </span>
                      <span className="command-history-actions">
                        <button
                          type="button"
                          title={x('commandHistory.copy')}
                          aria-label={x('commandHistory.copyCommand')}
                          onClick={() => void copy(item)}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          title={x('commandHistory.delete')}
                          aria-label={x('commandHistory.deleteCommand')}
                          disabled={busy}
                          onClick={() => void remove(item)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                  ))}
                  {history.data && !history.data.items.length && (
                    <div className="command-history-empty">
                      <History size={22} />
                      <p>
                        {x(settledSearch ? 'commandHistory.noMatches' : 'commandHistory.empty')}
                      </p>
                      {!settledSearch && <small>{x('commandHistory.waitingForShell')}</small>}
                    </div>
                  )}
                </div>
              </>
            )}
            {feedback && (
              <p className="command-history-feedback" role="status">
                {feedback}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
