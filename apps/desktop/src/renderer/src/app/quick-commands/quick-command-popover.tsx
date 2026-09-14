import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { Bookmark, BookmarkTree, QuickCommand, QuickCommandTree } from '@workspace/contracts';
import { Command, Play, Search, Square, Terminal, X } from 'lucide-react';
import { useWorkspace } from '../../stores/workspace';
import {
  expandQuickCommandTemplates,
  terminalSafeQuickCommandInsertion,
} from './quick-command-model';
import './quick-command-popover.css';
import { useI18n } from '../../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;
interface RunnableCommand {
  id: string;
  name: string;
  source: 'bookmark' | 'global';
  steps: Array<{ command: string; delayMs: number }>;
  inputOnly: boolean;
  global?: QuickCommand;
}

export function QuickCommandPopover({
  client,
  bookmarkTree,
  ready,
  onSend,
}: {
  client: Client;
  bookmarkTree: BookmarkTree | undefined;
  ready: boolean;
  onSend(data: string): boolean;
}) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const runController = useRef<AbortController | undefined>(undefined);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTerminalId = useWorkspace((state) => state.activeTerminalId);
  const insertTerminal = useWorkspace((state) => state.insertTerminal);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [runningId, setRunningId] = useState('');
  const [feedback, setFeedback] = useState('');
  const tree = useQuery({
    queryKey: ['quick-command-tree'],
    queryFn: client.quickCommandTree,
    enabled: ready,
  });
  const activeTab = tabs.find(({ id }) => id === activeTerminalId);
  const bookmark = resolveBookmark(activeTab?.bookmarkId, activeTab?.hostId, bookmarkTree);
  const commands = useMemo(
    () => runnableCommands(bookmark, tree.data, search),
    [bookmark, search, tree.data],
  );
  const canUse = !!activeTab && !activeTab.disconnected && !!activeTerminalId;

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

  async function expanded(command: RunnableCommand): Promise<string[]> {
    try {
      return await expandQuickCommandTemplates(command.steps, () => navigator.clipboard.readText());
    } catch {
      throw new Error(x('quickCommands.clipboardSendFailed'));
    }
  }

  async function insert(command: RunnableCommand) {
    if (!activeTerminalId || !canUse) return;
    setFeedback('');
    try {
      const text = terminalSafeQuickCommandInsertion(await expanded(command));
      if (!text) throw new Error(x('quickCommands.emptyCommand'));
      insertTerminal(activeTerminalId, text);
      await increment(command);
      setFeedback(x('quickCommands.inserted'));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : x('quickCommands.insertFailed'));
    }
  }

  async function send(command: RunnableCommand) {
    if (!canUse || runningId || runController.current) return;
    const controller = new AbortController();
    runController.current = controller;
    setRunningId(command.id);
    setFeedback('');
    try {
      const steps = await expanded(command);
      for (let index = 0; index < command.steps.length; index += 1) {
        await abortableDelay(command.steps[index]?.delayMs ?? 100, controller.signal);
        const value = steps[index];
        if (value === undefined) continue;
        if (!onSend(`${value}${command.inputOnly ? '' : '\r'}`))
          throw new Error(x('quickCommands.terminalNotReady'));
      }
      await increment(command);
      setFeedback(command.inputOnly ? x('quickCommands.writtenToInput') : x('quickCommands.sent'));
    } catch (error) {
      if (!controller.signal.aborted)
        setFeedback(error instanceof Error ? error.message : x('quickCommands.sendFailed'));
    } finally {
      if (runController.current === controller) runController.current = undefined;
      setRunningId('');
    }
  }

  async function increment(command: RunnableCommand) {
    if (!command.global || !tree.data) return;
    try {
      const next = await client.updateQuickCommand(tree.data, command.global.id, {
        clickCount: command.global.clickCount + 1,
      });
      queryClient.setQueryData(['quick-command-tree'], next);
      queryClient.setQueryData(['quick-commands'], next.commands);
    } catch {
      await queryClient.invalidateQueries({ queryKey: ['quick-command-tree'] });
    }
  }

  function cancel() {
    runController.current?.abort();
    setFeedback(x('quickCommands.remainingCanceled'));
  }

  return (
    <div className="quick-command-popover-root" ref={root}>
      <button
        className={open ? 'status-quick-command active' : 'status-quick-command'}
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
        <section className="quick-command-popover" aria-label={x('quickCommands.panel')}>
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
              <button type="button" className="danger" onClick={cancel}>
                <Square size={11} /> {x('common.cancel')}
              </button>
            )}
          </header>
          <div className="quick-command-popover-list">
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
                  className="primary"
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
            {!tree.isLoading && !commands.length && (
              <p className="quick-command-popover-empty">
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

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Canceled', 'AbortError'));
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Canceled', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
