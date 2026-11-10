import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TranslateNS } from '@axterm/ui';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
import type { TerminalHistoryCommands } from './commands.ts';
import { historyPageFor } from './projection.ts';
import styles from './history.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
import type { CommandHistoryItem, CommandHistorySort } from '@axterm/plugin-api/terminals';
import { Check, Copy, History, Trash2, X } from 'lucide-react';

export function CommandHistoryPopover({
  model,
  configuration,
  commands,
  activeTerminalId,
  x,
}: {
  model: TerminalFactsModel;
  configuration: ConfigurationClientActions;
  commands: TerminalHistoryCommands;
  activeTerminalId: string | undefined;
  x: TranslateNS<'terminals'>;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    settingsState = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const settings = settingsState.status === 'ready' ? settingsState.baseline.settings : undefined;
  const ready =
    facts.status === 'ready' &&
    settingsState.status === 'ready' &&
    facts.baseline.generation === settingsState.baseline.generation;
  const operation = async (invoke: () => Promise<void>) => {
    await invoke();
    if (commands.getSnapshot().failed) throw Error(x('commandHistory.updateFailed'));
  };
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

  const history = {
    data:
      facts.status === 'ready'
        ? historyPageFor(facts.baseline.history, sort, settledSearch)
        : undefined,
    isLoading: facts.status === 'connecting',
    isError: facts.status === 'error',
  };
  async function setEnabled(value: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      await operation(() => commands.setEnabled(value));
      setFeedback(x(value ? 'commandHistory.enabledNotice' : 'commandHistory.disabledNotice'));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function insert(item: CommandHistoryItem) {
    if (!activeTerminalId) {
      setFeedback(x('commandHistory.selectTerminal'));
      return;
    }
    try {
      await commands.insert(activeTerminalId, item);
      setFeedback(x('commandHistory.inserted'));
      setOpen(false);
    } catch {
      setFeedback(x('commandHistory.selectTerminal'));
    }
  }

  async function copy(item: CommandHistoryItem) {
    try {
      await commands.copy(item);
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
      await operation(() => commands.remove(item));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!history.data || busy) return;
    setBusy(true);
    setFeedback('');
    try {
      await operation(() => commands.clear());
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('commandHistory.clearFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cx('command-history-root')} ref={root}>
      <button
        className={cx(open ? 'status-command-history active' : 'status-command-history')}
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
        <section className={cx('command-history-popover')} aria-label={x('commandHistory.panel')}>
          <div className={cx('command-history-popover-content')}>
            <div className={cx('command-history-search')}>
              <div className={cx('command-history-search-field')}>
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
              <div className={cx('command-history-disabled')}>
                <History size={22} />
                <strong>{x('commandHistory.offByDefault')}</strong>
                <p>{x('commandHistory.privacyDescription')}</p>
                <button
                  type="button"
                  disabled={!ready || busy || command.busy || command.uncertain}
                  onClick={() => void setEnabled(true)}
                >
                  {x('commandHistory.enable')}
                </button>
              </div>
            ) : (
              <>
                <header className={cx('command-history-header')}>
                  <label>
                    <input
                      type="checkbox"
                      checked={sort === 'frequency'}
                      onChange={(event) => setSort(event.target.checked ? 'frequency' : 'recent')}
                    />
                    <span className={cx('history-check')}>
                      {sort === 'frequency' && <Check size={10} />}
                    </span>
                    {x('commandHistory.sortByFrequency')}
                  </label>
                  <button
                    type="button"
                    className={cx('command-history-clear')}
                    title={x('commandHistory.clear')}
                    aria-label={x('commandHistory.clear')}
                    disabled={
                      !ready ||
                      !history.data?.items.length ||
                      busy ||
                      command.busy ||
                      command.uncertain
                    }
                    onClick={() => void clear()}
                  >
                    <Trash2 size={13} />
                  </button>
                </header>
                <div className={cx('command-history-list')} aria-live="polite">
                  {history.isLoading && (
                    <p className={cx('command-history-empty')}>{x('commandHistory.loading')}</p>
                  )}
                  {history.isError && (
                    <p className={cx('command-history-empty')}>{x('commandHistory.unavailable')}</p>
                  )}
                  {history.data?.items.map((item) => (
                    <div className={cx('command-history-item')} key={item.id}>
                      <button
                        type="button"
                        className={cx('command-history-item-text')}
                        title={item.command}
                        disabled={!activeTerminalId || !ready}
                        onClick={() => void insert(item)}
                      >
                        {item.command}
                      </button>
                      <span
                        className={cx('command-history-count')}
                        title={x('commandHistory.usedCount', { count: item.count })}
                      >
                        {item.count}
                      </span>
                      <span className={cx('command-history-actions')}>
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
                          disabled={busy || command.busy || command.uncertain}
                          onClick={() => void remove(item)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    </div>
                  ))}
                  {history.data && !history.data.items.length && (
                    <div className={cx('command-history-empty')}>
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
            {command.uncertain && (
              <button onClick={() => void commands.retry()}>{x('retry')}</button>
            )}
            {feedback && (
              <p className={cx('command-history-feedback')} role="status">
                {feedback}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
