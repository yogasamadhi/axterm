import { useSyncExternalStore } from 'react';
import { useAutomation, useAutomationFacts, useTerminalTarget } from './context.tsx';
import { cx } from './styles.ts';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { Bookmark, BookmarkTree } from '@axterm/plugin-api/catalog';
import type { QuickCommand, QuickCommandTree } from '@axterm/plugin-api/automation';
import { Command, Play, Search, Square, Terminal, X } from 'lucide-react';

import { useI18n } from './context.tsx';

interface RunnableCommand {
  id: string;
  name: string;
  source: 'bookmark' | 'global';
  steps: Array<{ command: string; delayMs: number }>;
  inputOnly: boolean;
  global?: QuickCommand;
}

export function QuickCommandPopover() {
  const { x } = useI18n();
  const { commands: client, catalog, runner } = useAutomation(),
    state = useAutomationFacts();
  const catalogState = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  const bookmarkTree =
    catalogState.status === 'ready' ? catalogState.baseline.bookmarks : undefined;
  const { target: activeTerminalId, session: activeTab, ready: canUse } = useTerminalTarget();
  const root = useRef<HTMLDivElement>(null),
    runController = useRef<AbortController>();
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [runningId, setRunningId] = useState(''),
    [feedback, setFeedback] = useState('');
  const tree = state.status === 'ready' ? state.baseline.quickCommands : undefined;
  const bookmark = resolveBookmark(activeTab?.bookmarkId, undefined, bookmarkTree);
  const commands = useMemo(
    () => runnableCommands(bookmark, tree, search),
    [bookmark, tree, search],
  );
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  useEffect(() => () => runController.current?.abort(), []);

  async function insert(command: RunnableCommand) {
    if (!activeTerminalId || !canUse || runController.current) return;
    const controller = new AbortController();
    runController.current = controller;
    setRunningId(command.id);
    setFeedback('');
    try {
      await runner.insert(
        activeTerminalId,
        { steps: command.steps, inputOnly: command.inputOnly },
        controller.signal,
      );
      await increment(command);
      setFeedback(x('quickCommands.inserted'));
    } catch {
      if (!controller.signal.aborted) setFeedback(x('quickCommands.insertFailed'));
    } finally {
      if (runController.current === controller) runController.current = undefined;
      setRunningId('');
    }
  }
  async function send(command: RunnableCommand) {
    if (!activeTerminalId || !canUse || runController.current) return;
    const controller = new AbortController();
    runController.current = controller;
    setRunningId(command.id);
    setFeedback('');
    try {
      await runner.run(
        activeTerminalId,
        { steps: command.steps, inputOnly: command.inputOnly },
        controller.signal,
      );
      await increment(command);
      setFeedback(x(command.inputOnly ? 'quickCommands.writtenToInput' : 'quickCommands.sent'));
    } catch {
      if (!controller.signal.aborted) setFeedback(x('quickCommands.sendFailed'));
    } finally {
      if (runController.current === controller) runController.current = undefined;
      setRunningId('');
    }
  }
  async function increment(command: RunnableCommand) {
    if (!command.global || !tree) return;
    try {
      await client.updateQuickCommand(tree, command.global.id, {
        clickCount: command.global.clickCount + 1,
      });
    } catch {
      /* A lost counter update retains its own exact intent; never resubmit terminal input. */
    }
  }

  function cancel() {
    runController.current?.abort();
    setFeedback(x('quickCommands.remainingCanceled'));
  }

  return (
    <div className={cx('quick-command-popover-root')} ref={root}>
      <button
        className={cx(open ? 'status-quick-command active' : 'status-quick-command')}
        type="button"
        title={x('quickCommands.title')}
        aria-label={x('quickCommands.title')}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Command size={13} />
        <span>{x('quickCommands.shortTitle')}</span>
        {!!bookmark?.quickCommands.length && <small>{bookmark.quickCommands.length}</small>}
      </button>
      {open && (
        <section className={cx('quick-command-popover')} aria-label={x('quickCommands.panel')}>
          <header>
            <label>
              <Search size={13} />
              <input
                autoFocus
                aria-label={x('quickCommands.search')}
                value={search}
                placeholder={x('quickCommands.search')}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button
                  type="button"
                  aria-label={x('quickCommands.clearSearch')}
                  onClick={() => setSearch('')}
                >
                  <X size={12} />
                </button>
              )}
            </label>
            {runningId && (
              <button type="button" className={cx('danger')} onClick={cancel}>
                <Square size={11} /> {x('common.cancel')}
              </button>
            )}
          </header>
          <div className={cx('quick-command-popover-list')}>
            {commands.map((command) => (
              <article key={command.id}>
                <div>
                  <strong>{command.name}</strong>
                  <span>
                    {command.source === 'bookmark'
                      ? x('quickCommands.currentBookmark')
                      : x('quickCommands.global')}
                  </span>
                  <code>{command.steps.map(({ command: value }) => value).join(' · ')}</code>
                </div>
                <button
                  type="button"
                  disabled={!canUse || !!runningId}
                  title={x('quickCommands.insertWithoutRun')}
                  onClick={() => void insert(command)}
                >
                  <Terminal size={12} /> {x('quickCommands.insert')}
                </button>
                <button
                  className={cx('primary')}
                  type="button"
                  disabled={!canUse || !!runningId}
                  title={
                    command.inputOnly
                      ? x('quickCommands.writeWithoutEnter')
                      : x('quickCommands.sendAndRun')
                  }
                  onClick={() => void send(command)}
                >
                  <Play size={12} />{' '}
                  {runningId === command.id ? x('quickCommands.running') : x('quickCommands.send')}
                </button>
              </article>
            ))}
            {state.status !== 'connecting' && !commands.length && (
              <p className={cx('quick-command-popover-empty')}>
                {search ? x('quickCommands.noMatches') : x('quickCommands.noneAvailable')}
              </p>
            )}
          </div>
          {feedback && <footer aria-live="polite">{feedback}</footer>}
        </section>
      )}
    </div>
  );
}

function resolveBookmark(
  bookmarkId: string | undefined,
  hostId: string | undefined,
  tree: BookmarkTree | undefined,
): Bookmark | undefined {
  return tree?.bookmarks.find(
    (bookmark) => bookmark.id === bookmarkId || (!!hostId && bookmark.hostId === hostId),
  );
}

function runnableCommands(
  bookmark: Bookmark | undefined,
  tree: QuickCommandTree | undefined,
  rawSearch: string,
): RunnableCommand[] {
  const commands: RunnableCommand[] = [
    ...(bookmark?.quickCommands.map((command, index) => ({
      id: `bookmark:${bookmark.id}:${index}`,
      name: command.name,
      source: 'bookmark' as const,
      steps: [{ command: command.command, delayMs: 100 }],
      inputOnly: false,
    })) ?? []),
    ...(tree?.commands.map((command) => ({
      id: `global:${command.id}`,
      name: command.name,
      source: 'global' as const,
      steps: command.commands,
      inputOnly: command.inputOnly,
      global: command,
    })) ?? []),
  ];
  const search = rawSearch.trim().toLocaleLowerCase();
  return search
    ? commands.filter((command) =>
        `${command.name}\n${command.steps.map(({ command: value }) => value).join('\n')}`
          .toLocaleLowerCase()
          .includes(search),
      )
    : commands;
}
