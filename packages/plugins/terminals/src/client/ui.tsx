import { TERMINAL_ENCODINGS, type TerminalBehavior } from '@axterm/plugin-api/terminals';
import { TerminalFilePanes } from './files/owner.ts';
import { TerminalFileDropOwner, type TerminalDropState } from './drop/owner.ts';
import { TerminalFileDropDialog } from './drop/dialog.tsx';
import { cssText as dropCss, cx as dropCx } from './drop/styles.ts';
import { installTerminalSessionDescriptions } from './session-descriptions.ts';
import { installTerminalGestureUi } from './gestures/index.tsx';
import { installTerminalGestures } from './gestures/input.ts';
import { installTerminalShortcuts } from './shortcuts.ts';
import { TerminalSuggestionOwner } from './suggestions/owner.ts';
import {
  TerminalCommandSuggestions,
  type TerminalCommandSuggestionsState,
} from './suggestions/panel.tsx';
import { terminalCommandSuggestionPosition } from './suggestions/position.ts';
import { cssText as suggestionCss } from './suggestions/suggestions.module.css';
import toolStyles from './tools/tools.module.css';
import { installTerminalTools } from './tools/index.tsx';
import {
  TerminalReconnectTransitionTracker,
  terminalReconnectPresentation,
} from './session/reconnect.ts';
import { TerminalReconnectOverlay } from './session/reconnect-overlay.tsx';
import { cssText as reconnectCss } from './session/reconnect.module.css';
import { SerializeAddon } from '@xterm/addon-serialize';
import { TerminalSessionActions } from './session/actions.ts';
import { installSessionMenus } from './session/menus.tsx';
import {
  TerminalReloadStateRegistry,
  createTerminalReloadState,
  getAlternateBufferSnapshot,
  createRestoreCwdInput,
  type TerminalReloadState,
} from './session/reload-state.ts';
import { createTerminalOutputDecoder, decodeTerminalOutput } from './rendering/output.ts';
import { TerminalOutputProjection } from './terminal-output-projection.ts';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Osc52Addon } from './rendering/osc52.ts';
import {
  installTerminalCapabilities,
  type TerminalCapabilityState,
} from './rendering/capabilities.ts';
import {
  installTerminalCompositionGuard,
  terminalBackspaceSequence,
  terminalShiftEnterSequence,
  terminalCtrlCPress,
  terminalClipboardShortcut,
  terminalDefersApplicationShortcut,
} from './rendering/key-input.ts';
import {
  formatUnixTimestampSelection,
  type TerminalPointerPosition,
} from './rendering/timestamp.ts';
import { TerminalTimestampTooltip } from './rendering/timestamp-tooltip.tsx';
import { cssText as renderingCss } from './rendering/rendering.module.css';
import { installTerminalKeyBar } from './keybar/index.tsx';
import { resolveTerminalShortcutCursorMode } from './keybar/model.ts';
import { readNormalBuffer } from './interactions/normal-buffer.ts';
import { useTerminalAppearance } from './visuals/appearance.tsx';
import { TerminalVisualOwner } from './visuals/owner.ts';
import { SearchAddon } from '@xterm/addon-search';
import { TerminalViewOwner } from './interactions/owner.ts';
import { TerminalSearchBar } from './interactions/search-bar.tsx';
import {
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  TERMINAL_SEARCH_QUERY_LIMIT,
  validateTerminalSearch,
  toggleTerminalSearchOption,
  type TerminalSearchOptions,
  type TerminalSearchResults,
} from './interactions/policy.ts';
import interactionStyles, {
  cssText as interactionCss,
} from './interactions/interactions.module.css';
import { directoryFromOsc633 } from './active-directory.ts';
import { TerminalWorkspaceAdmissions } from './workspace-owner.ts';
import { TerminalDraftOwner } from './draft-owner.ts';
import { dictionaries } from './locales.ts';
import type { PropsLocale, PropsRenderSlots } from '@axterm/ui';
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@axterm/ui/controls';
import { Search, Maximize2, Minimize2, Terminal as TerminalIcon, List } from 'lucide-react';
import { TerminalPasteDialog } from './paste-dialog.tsx';
import {
  assessTerminalPaste,
  normalizeTerminalPaste,
  terminalPlatformFromUserAgent,
  type TerminalPasteReview,
} from './paste.ts';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import type {
  WorkspaceTabRegistration,
  WorkspaceSessionOwner,
  WorkspacePanelOwner,
} from '@axterm/ui/workspace';
import type {} from '@axterm/ui';
import type { TerminalsModel } from './index.ts';
import { TerminalStream } from './stream.ts';
import { cssText as terminalCss } from '@xterm/xterm/css/xterm.css';
import styles, { cssText } from './ui.module.css';
const cx = (...names: string[]) => names.map((name) => `${name} ${styles[name] ?? ''}`).join(' ');
/** Terminals owns its UI contributions, model commands and byte renderer. */
export function installTerminalUi(ctx: Context, model: TerminalsModel): void {
  ctx.effect(() => ctx.locale.register('terminals', dictionaries));
  const workspace = ctx.workspaceUi;
  const interactions = new TerminalViewOwner();
  ctx.provide('terminalViewUi', interactions);
  ctx.effect(() => () => interactions.dispose());
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/interactions';
    style.textContent = interactionCss;
    document.head.append(style);
    return () => style.remove();
  });
  const encodingOverrides = new Map<string, TerminalBehavior['encoding']>();
  const encodingListeners = new Set<() => void>();
  let encodingRevision = 0;
  const encodingSnapshot = () => encodingRevision;
  const encodingChanged = () => {
    encodingRevision++;
    for (const listener of [...encodingListeners]) listener();
  };
  const subscribeEncoding = (listener: () => void) => {
    encodingListeners.add(listener);
    return () => {
      encodingListeners.delete(listener);
    };
  };
  ctx.effect(() => () => {
    encodingOverrides.clear();
    encodingListeners.clear();
  });
  const directories = new Map<string, string>();
  let lastSshTerminal: string | undefined;
  ctx.effect(() =>
    workspace.subscribe(() => {
      const state = model.getSnapshot(),
        id = workspace.getSnapshot().activeTabId;
      if (
        state.status === 'ready' &&
        id &&
        state.baseline.sessions.some((item) => item.id === id && item.kind === 'ssh')
      )
        lastSshTerminal = id;
    }),
  );
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals/rendering';
    style.textContent = renderingCss + '\n' + reconnectCss + '\n' + suggestionCss + '\n' + dropCss;
    document.head.append(style);
    return () => style.remove();
  });
  const visuals = new TerminalVisualOwner();
  ctx.provide('terminalVisualUi', visuals);
  ctx.effect(() => () => visuals.dispose());
  const sessionActionsOwner: { current?: TerminalSessionActions } = {};
  const reloadStates = new TerminalReloadStateRegistry();
  const captures = new Map<string, () => TerminalReloadState | undefined>();
  ctx.effect(() => () => {
    reloadStates.clear();
    captures.clear();
  });
  const visualRegistrations = new Map<string, () => void>();
  const registrations = new Map<string, WorkspaceTabRegistration>();
  const titles = new Map<string, string>();
  const views = new Set<() => void>();
  const terminalModes = new Map<string, () => void>();
  const drafts = new TerminalDraftOwner((id) => {
    if (!workspace.getSnapshot().tabs.some((tab) => tab.id === id && tab.kind === 'terminal'))
      throw new Error('TERMINAL_DRAFT_UNAVAILABLE');
    workspace.selectTab(id);
    terminalModes.get(id)?.();
  });
  const inputSinks = new Map<string, (text: string) => boolean>();
  const shortcutSinks = new Map<string, (data: string) => boolean>();
  installTerminalKeyBar(ctx, shortcutSinks);
  const pending = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  const track = <T,>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const filePanes = new TerminalFilePanes(
    () => {
      const state = model.getSnapshot();
      return state.status === 'ready' ? state.baseline : undefined;
    },
    () => ctx.get('filesWorkspaceUi'),
    lifetime.signal,
  );
  const releaseFilePane = (id: string, generation?: string) => filePanes.release(id, generation);
  const prepareFilePane = (id: string, generation: string) => filePanes.prepare(id, generation);
  const closeTerminal = async (id: string, generation: string) => {
    await releaseFilePane(id, generation);
    await model.close(id, generation);
  };
  ctx.effect(() => async () => {
    lifetime.abort();
    terminalModes.clear();
    const closed = await Promise.allSettled(
      [...views].map((dispose) => Promise.resolve().then(dispose)),
    );
    await Promise.allSettled([...pending]);
    const fileResults = await Promise.allSettled([filePanes.close()]);
    await drafts.dispose();
    if ([...closed, ...fileResults].some((result) => result.status === 'rejected'))
      throw new Error('TERMINAL_UI_DRAIN_FAILED');
  });
  ctx.provide('terminalInputUi', {
    async sendInput(id, text, signal) {
      signal?.throwIfAborted();
      if (
        lifetime.signal.aborted ||
        typeof text !== 'string' ||
        new TextEncoder().encode(text).byteLength > 256 * 1024
      )
        throw Error('TERMINAL_INPUT_UNAVAILABLE');
      const state = model.getSnapshot();
      if (
        state.status !== 'ready' ||
        !state.baseline.sessions.some((item) => item.id === id && item.state === 'ready') ||
        !inputSinks.get(id)?.(text)
      )
        throw Error('TERMINAL_INPUT_UNAVAILABLE');
    },
  });
  ctx.provide('terminalDraftUi', {
    insertDraft: (id, text, signal) => {
      if (lifetime.signal.aborted) return Promise.reject(new Error('TERMINAL_DRAFT_CLOSED'));
      const connection = ctx.get('connection') as unknown as ConnectionHandle;
      const generation = connection.generation.getSnapshot();
      if (!generation) return Promise.reject(new Error('TERMINAL_DRAFT_UNAVAILABLE'));
      const retired = new AbortController();
      const off = connection.generation.subscribe(() => {
        if (connection.generation.getSnapshot() !== generation) retired.abort();
      });
      const owned = AbortSignal.any([lifetime.signal, retired.signal, ...(signal ? [signal] : [])]);
      if (connection.generation.getSnapshot() !== generation) retired.abort();
      try {
        return track(drafts.insertDraft(id, text, owned)).finally(off);
      } catch (error) {
        off();
        throw error;
      }
    },
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-terminals';
    style.dataset.plugin = '@axterm/plugin-terminals';
    style.textContent = terminalCss + '\n' + cssText;
    document.head.append(style);
    return () => style.remove();
  });
  let registeredGeneration: string | undefined;
  const sync = () => {
    const state = model.getSnapshot();
    if (state.status !== 'ready') return;
    const generation = state.baseline.generation;
    if (registeredGeneration !== generation) {
      encodingOverrides.clear();
      encodingChanged();
      reloadStates.clear();
      captures.clear();
      sessionActionsOwner.current?.retire(generation);
      for (const release of visualRegistrations.values()) release();
      visualRegistrations.clear();
      for (const registration of registrations.values()) registration.dispose();
      registrations.clear();
      titles.clear();
      directories.clear();
      registeredGeneration = generation;
    }
    const sessions = state.baseline.sessions;
    const ids = new Set(sessions.map((item) => item.id));
    for (const [id, registration] of registrations)
      if (!ids.has(id)) {
        visualRegistrations.get(id)?.();
        visualRegistrations.delete(id);
        registration.dispose();
        registrations.delete(id);
        titles.delete(id);
        directories.delete(id);
        reloadStates.delete(id);
        if (encodingOverrides.delete(id)) encodingChanged();
      }
    for (const session of sessions) {
      const tab = {
        id: session.id,
        kind: 'terminal',
        title: titles.get(session.id) ?? session.title,
        icon: 'terminal' as const,
      };
      const existing = registrations.get(session.id);
      if (existing) existing.update(tab);
      else {
        const registration = workspace.registerTab(tab, () =>
          track(closeTerminal(session.id, generation)),
        );
        registrations.set(session.id, registration);
        visualRegistrations.set(session.id, visuals.register(session.id, registration));
      }
    }
  };
  ctx.effect(() => {
    const off = model.subscribe(sync);
    sync();
    return () => {
      off();
      for (const release of visualRegistrations.values()) release();
      visualRegistrations.clear();
      for (const registration of registrations.values()) registration.dispose();
      registrations.clear();
      titles.clear();
      directories.clear();
    };
  });
  ctx.effect(() =>
    workspace.registerNavigation({
      id: 'sessions',
      label: {
        en: dictionaries.en.sessions,
        ja: dictionaries.ja.sessions,
        'zh-CN': dictionaries['zh-CN'].sessions,
        'zh-TW': dictionaries['zh-TW'].sessions,
      },
      icon: <span aria-hidden="true">⌘</span>,
      order: 10,
    }),
  );
  const admissions = new TerminalWorkspaceAdmissions(model, (id, title) => {
    if (title !== undefined) titles.set(id, title);
    sync();
    const tab = registrations.get(id);
    if (!tab) throw new Error('TERMINAL_WORKSPACE_UNAVAILABLE');
    if (title !== undefined) tab.present?.({ title });
    tab.activate();
  });
  installTerminalSessionDescriptions(ctx, model);
  ctx.provide('terminalWorkspaceUi', {
    getActiveDirectory: () => {
      const state = model.getSnapshot(),
        selected = workspace.getSnapshot().activeTabId;
      const id =
        state.status === 'ready' &&
        state.baseline.sessions.some((item) => item.id === selected && item.kind === 'ssh')
          ? selected
          : lastSshTerminal;
      if (state.status !== 'ready' || !id) return;
      const session = state.baseline.sessions.find((item) => item.id === id);
      const path = directories.get(id);
      return session?.kind === 'ssh' && session.connectionId && path
        ? { connectionId: session.connectionId, path }
        : undefined;
    },
    open: (input, signal, presentation) => admissions.open(input, signal, presentation?.title),
    activate: (id) => admissions.activate(id),
  });
  ctx.effect(() => () => admissions.dispose());
  const sessions = new TerminalSessionActions(
    {
      getSnapshot: model.getSnapshot,
      subscribe: model.subscribe,
      disconnect: (key, id, generation) => model.disconnect(key, id, generation),
      getCommandOutcome: (generation, key) => model.getCommandOutcome(generation, key),
      close: closeTerminal,
    },
    admissions,
    workspace,
    ctx.connectionActions,
    (id) => {
      const config = ctx.configurationActions.getSnapshot();
      if (
        config.status !== 'ready' ||
        !config.baseline.settings.terminal.restoreTerminalSessionOnReload
      )
        return;
      const snapshot = captures.get(id)?.();
      if (snapshot) {
        const generation = config.baseline.generation;
        return (created) => {
          if (generation !== registeredGeneration) throw Error('TERMINAL_RELOAD_RETIRED');
          reloadStates.set(created, snapshot);
        };
      }
    },
    (id, sourceId) => {
      const source = workspace.getSnapshot().tabs.find((tab) => tab.id === sourceId);
      if (!source) throw Error('TERMINAL_RELOAD_SOURCE_RETIRED');
      titles.set(id, source.title);
      registrations.get(id)?.present?.({
        title: source.title,
        ...(source.terminalVisual ? { terminalVisual: source.terminalVisual } : {}),
      });
    },
  );
  sessionActionsOwner.current = sessions;
  ctx.provide('terminalSessionUi', sessions);
  ctx.effect(() => () => sessions.close());
  installSessionMenus(ctx, model, sessions);
  const tools = installTerminalTools(ctx, model, inputSinks);
  ctx.effect(() => {
    const tracker = new TerminalReconnectTransitionTracker();
    const recovering = new Set<string>();
    const synchronize = () => {
      const state = model.getSnapshot(),
        connections = ctx.connectionActions.getSnapshot();
      if (
        state.status !== 'ready' ||
        connections.status !== 'ready' ||
        connections.baseline.generation !== state.baseline.generation
      )
        return;
      const generation = state.baseline.generation;
      for (const connection of connections.baseline.connections) {
        if (!tracker.observe(generation, connection) || recovering.has(connection.id)) continue;
        const ids = state.baseline.sessions
          .filter((session) => session.kind === 'ssh' && session.connectionId === connection.id)
          .map((session) => session.id);
        if (!ids.length) continue;
        recovering.add(connection.id);
        const task = (async () => {
          for (const id of ids) {
            const current = model.getSnapshot(),
              currentConnections = ctx.connectionActions.getSnapshot();
            if (
              lifetime.signal.aborted ||
              current.status !== 'ready' ||
              current.baseline.generation !== generation ||
              currentConnections.status !== 'ready' ||
              currentConnections.baseline.generation !== generation ||
              !currentConnections.baseline.connections.some(
                (value) => value.id === connection.id && value.state === 'ready',
              )
            )
              break;
            if (!current.baseline.sessions.some((value) => value.id === id)) continue;
            try {
              await sessions.recover(id, generation);
            } catch {
              /* The session owner retains failure/cleanup and exposes its notice. */
            }
          }
        })().finally(() => recovering.delete(connection.id));
        void track(task).catch(() => {});
      }
    };
    const off = ctx.connectionActions.subscribe(synchronize);
    synchronize();
    return () => {
      off();
      tracker.reset();
    };
  });

  ctx.effect(() =>
    workspace.registerAction('new-terminal', (signal) =>
      admissions.open({ kind: 'local', cols: 80, rows: 24 }, signal).then(() => {}),
    ),
  );
  installTerminalShortcuts(ctx, model);
  installTerminalGestureUi(ctx);
  const create = () => {
    void workspace.invokeAction('new-terminal').catch(() => {});
  };
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'terminals.refresh', order: 55, locale: 'terminals' },
      function RefreshMetadata({ t }: PropsLocale<'terminals'>) {
        const [busy, setBusy] = useState(false);
        const [failed, setFailed] = useState(false);
        const live = useRef(true);
        useEffect(() => {
          live.current = true;
          return () => {
            live.current = false;
          };
        }, []);
        return (
          <>
            <Button
              data-terminals-refresh
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void model
                  .retry()
                  .catch(() => {
                    if (live.current) setFailed(true);
                  })
                  .finally(() => {
                    if (live.current) setBusy(false);
                  });
              }}
            >
              {t('refreshSessions')}
            </Button>
            {failed && <span role="alert">{t('metadataUnavailable')}</span>}
          </>
        );
      },
    );
    yield ctx.slots.register(
      { name: 'workspace.toolbar', id: 'terminals.new', order: 10, locale: 'terminals' },
      function NewTerminal({ t }: PropsLocale<'terminals'>) {
        const [failed, setFailed] = useState(false);
        return (
          <>
            <Button
              variant="ghost"
              className={cx('tab-add')}
              data-terminal-new=""
              aria-label={t('newTerminal')}
              title={t('newTerminalHint')}
              onClick={() => {
                setFailed(false);
                void workspace.invokeAction('new-terminal').catch(() => setFailed(true));
              }}
            >
              +
            </Button>
            {failed && <span role="alert">{t('openFailed')}</span>}
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.sidebar', function* () {
    yield ctx.slots.register(
      { name: 'workspace.sidebar', key: 'sessions', locale: 'terminals' },
      function Sessions({ t }: PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const ui = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
        return (
          <div className={cx('session-list')}>
            <Button variant="ghost" className={cx('session-empty')} onClick={create}>
              {t('newTerminal')}
            </Button>
            {state.status === 'ready' ? (
              state.baseline.sessions
                .filter((item) => item.state !== 'closed')
                .map((item) => (
                  <Button
                    variant="ghost"
                    key={item.id}
                    className={cx('explorer-session-row')}
                    aria-current={ui.activeTabId === item.id ? 'true' : undefined}
                    onClick={() => workspace.selectTab(item.id)}
                  >
                    {item.title}
                  </Button>
                ))
            ) : (
              <p role="status">
                {t('metadataUnavailable')}{' '}
                <Button
                  variant="ghost"
                  onClick={() => {
                    void model.retry();
                  }}
                >
                  {t('retry')}
                </Button>
              </p>
            )}
          </div>
        );
      },
    );
  });
  ctx.slots.inject('workspace.empty', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.empty',
        locale: 'terminals',
        children: {
          'workspace.empty.actions': { kind: 'list', scope: 'root' },
          'workspace.empty.content': { kind: 'list', scope: 'root' },
        },
      },
      function EmptyTerminal(
        props: WorkspacePanelOwner &
          PropsLocale<'terminals'> &
          PropsRenderSlots<'workspace.empty.actions' | 'workspace.empty.content'>,
      ) {
        const { t } = props;
        const owner: WorkspacePanelOwner = {
          section: props.section,
          activeTabId: props.activeTabId,
          ...(props.paneIndex === undefined ? {} : { paneIndex: props.paneIndex }),
        };
        const pane = props.paneIndex ?? 0;
        const split = props.paneIndex !== undefined;
        const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
        const [failed, setFailed] = useState(false);
        return (
          <div
            className={cx(split ? 'empty-pane-landing' : 'no-session-view')}
            data-layout={state.arrangement?.mode ?? 'c1'}
            data-focused={state.arrangement?.focusedPane === pane ? 'true' : 'false'}
            data-testid={`empty-pane-${pane + 1}`}
            role="region"
            aria-label={t('paneSession', { number: pane + 1 })}
          >
            {split && (
              <div className={cx('empty-pane-intro')}>
                <span className={cx('empty-pane-glyph')} aria-hidden="true">
                  <TerminalIcon size={22} strokeWidth={1.8} />
                </span>
                <h2>{t('localTerminal')}</h2>
              </div>
            )}
            <div className={split ? cx('empty-pane-actions') : cx('no-session-actions')}>
              <button
                className={cx(
                  split ? 'empty-pane-new-terminal' : 'no-session-primary',
                  ...(split ? ['primary'] : []),
                )}
                onClick={() => {
                  setFailed(false);
                  if (split) {
                    if (!workspace.arrange) {
                      setFailed(true);
                      return;
                    }
                    workspace.arrange.focusPane(pane);
                  }
                  void workspace.invokeAction('new-terminal').catch(() => setFailed(true));
                }}
              >
                {split && <TerminalIcon size={14} />}
                {t('newTerminal')}
              </button>
              {props.renderSlot('workspace.empty.actions', owner)}
            </div>
            {failed && <p role="alert">{t('openFailed')}</p>}
            {!split && props.renderSlot('workspace.empty.content', owner)}
            {split && state.tabs.length > 0 && (
              <footer>
                <label
                  className={cx('empty-pane-session')}
                  title={t('selectExistingSessionForPane', { number: pane + 1 })}
                >
                  <List size={14} aria-hidden="true" />
                  <span>{t('selectSession')}</span>
                  <select
                    aria-label={t('selectExistingSessionForPane', { number: pane + 1 })}
                    value=""
                    onChange={(event) => {
                      if (!workspace.arrange) {
                        setFailed(true);
                        return;
                      }
                      workspace.arrange.moveToPane(event.target.value, pane);
                    }}
                  >
                    <option value="" disabled>
                      {t('selectExistingSession')}
                    </option>
                    {state.tabs.map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        {tab.title}
                      </option>
                    ))}
                  </select>
                </label>
              </footer>
            )}
          </div>
        );
      },
    );
  });
  ctx.slots.inject('workspace.session', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.session',
        key: 'terminal',
        locale: 'terminals',
        children: { 'terminal.files': { kind: 'single', scope: 'root' } },
      },
      function TerminalSessionView(
        props: WorkspaceSessionOwner &
          PropsLocale<'terminals'> &
          PropsRenderSlots<'terminal.files'>,
      ) {
        const { tabId } = props;
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
        const carrier = ctx.get('connection') as unknown as ConnectionHandle;
        const carrierGeneration = useSyncExternalStore(
          carrier.generation.subscribe,
          carrier.generation.getSnapshot,
        );
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((item) => item.id === tabId)
            : undefined;
        useSyncExternalStore(subscribeEncoding, encodingSnapshot);
        const encoding = encodingOverrides.get(tabId) ?? session?.behavior.encoding;
        const appearance = useTerminalAppearance(ctx, visuals, tabId, track, lifetime.signal);
        const container = useRef<HTMLDivElement>(null);
        const view = useRef<{ terminal: Terminal; fit: () => void; search: SearchAddon }>();
        const [filesOpen, setFilesOpen] = useState(false),
          [filesPrepared, setFilesPrepared] = useState(false),
          [filesBusy, setFilesBusy] = useState(false),
          [filesFailed, setFilesFailed] = useState(false);
        const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
        useSyncExternalStore(
          (notify) => ctx.slots.subscribe('terminal.files', notify),
          () => ctx.slots.getVersion('terminal.files'),
        );
        const filesAvailable = ctx.slots.entries('terminal.files').length > 0;
        const active = useRef(props.active && !filesOpen);
        useLayoutEffect(() => {
          active.current = props.active && !filesOpen;
        }, [props.active, filesOpen]);
        const selectMode = (mode: string) => {
          if (mode === 'terminal') {
            setFilesOpen(false);
            return;
          }
          if (filesBusy || state.status !== 'ready') return;
          const generation = state.baseline.generation;
          setFilesBusy(true);
          setFilesFailed(false);
          void track(prepareFilePane(tabId, generation))
            .then(
              () => {
                if (container.current) {
                  setFilesPrepared(true);
                  setFilesOpen(true);
                }
              },
              () => {
                if (container.current) setFilesFailed(true);
              },
            )
            .finally(() => {
              if (container.current) setFilesBusy(false);
            });
        };
        useEffect(() => {
          const current = model.getSnapshot();
          const generation = current.status === 'ready' ? current.baseline.generation : undefined;
          const show = () => setFilesOpen(false);
          terminalModes.set(tabId, show);
          return () => {
            if (terminalModes.get(tabId) === show) terminalModes.delete(tabId);
            void track(releaseFilePane(tabId, generation)).catch(() => {});
          };
        }, [tabId]);
        useEffect(() => {
          if (!filesAvailable) {
            setFilesOpen(false);
            setFilesPrepared(false);
          }
        }, [filesAvailable]);
        const [started, setStarted] = useState(props.active);
        if (props.active && !started) setStarted(true);
        const connectionState = useSyncExternalStore(
          ctx.connectionActions.subscribe,
          ctx.connectionActions.getSnapshot,
        );
        const sessionActions = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
        const recordingState = useSyncExternalStore(
          tools.recording.subscribe,
          tools.recording.getSnapshot,
        );
        const connection =
          connectionState.status === 'ready'
            ? connectionState.baseline.connections.find(
                (connection) => connection.id === session?.connectionId,
              )
            : undefined;
        const [sessionCommand, setSessionCommand] = useState<'reload' | 'cancel'>();
        const runSession = (kind: 'reload' | 'cancel') => {
          setSessionCommand(kind);
          const task = kind === 'reload' ? sessions.reload(tabId) : sessions.cancelReconnect(tabId);
          void task
            .catch(() => {})
            .finally(() => {
              if (container.current) setSessionCommand(undefined);
            });
        };
        const [exited, setExited] = useState(false);
        const [failed, setFailed] = useState(false);
        const [attempt, setAttempt] = useState(0);
        const [channelReady, setChannelReady] = useState(false);
        const pendingPaste = useRef<{ text: string; review: TerminalPasteReview }>();
        const [reviewPaste, setReviewPaste] = useState(false);
        const [inputRejected, setInputRejected] = useState(false);
        const searchInput = useRef<HTMLInputElement>(null);
        const [searchOpen, setSearchOpen] = useState(false);
        const [searchQuery, setSearchQuery] = useState('');
        const [searchOptions, setSearchOptions] = useState<TerminalSearchOptions>({
          ...DEFAULT_TERMINAL_SEARCH_OPTIONS,
        });
        const [searchResults, setSearchResults] = useState<TerminalSearchResults>({
          resultIndex: -1,
          resultCount: 0,
        });
        const [searchError, setSearchError] = useState<string>();
        const [interactionMessage, setInteractionMessage] = useState<string>();
        const [interactionFeedback, setInteractionFeedback] = useState<string>();
        useEffect(() => {
          if (!interactionFeedback) return;
          const timer = setTimeout(() => setInteractionFeedback(undefined), 2400);
          return () => clearTimeout(timer);
        }, [interactionFeedback]);
        const [suggestionState, setSuggestionState] = useState<TerminalCommandSuggestionsState>();
        const suggestions = useRef<TerminalSuggestionOwner>();
        const dropOwner = useRef<TerminalFileDropOwner>();
        const dragDepth = useRef(0);
        const [dropActive, setDropActive] = useState(false);
        const [dropState, setDropState] = useState<TerminalDropState>({
          phase: 'idle',
          names: [],
          canUpload: false,
        });
        const runDrop = (run: () => Promise<void>) => {
          try {
            void track(run()).catch(() => {
              if (container.current) setInteractionMessage(props.t('dropReadError'));
            });
          } catch {
            setInteractionMessage(props.t('dropReadError'));
          }
        };
        useEffect(() => {
          suggestions.current?.updated();
        }, [props.active]);

        const [capability, setCapability] = useState<TerminalCapabilityState>();
        const [timestamp, setTimestamp] = useState<{
          text: string;
          pointer: TerminalPointerPosition;
        }>();
        const [normalOpen, setNormalOpen] = useState(false);
        const normalSnapshot = useRef<string>();
        const normalElement = useRef<HTMLPreElement>(null);
        const normalClose = useRef<HTMLButtonElement>(null);
        const releaseNormalContent = useCallback(() => {
          normalSnapshot.current = undefined;
          if (normalElement.current) normalElement.current.textContent = '';
        }, []);
        const closeNormalBuffer = useCallback(() => {
          releaseNormalContent();
          setNormalOpen(false);
          view.current?.terminal.focus();
        }, [releaseNormalContent]);
        useLayoutEffect(() => {
          if (normalOpen && normalElement.current)
            normalElement.current.textContent = normalSnapshot.current ?? '';
        }, [normalOpen]);
        useEffect(() => {
          if (normalOpen) normalClose.current?.focus();
        }, [normalOpen]);

        const latestSearch = useRef({ query: searchQuery, options: searchOptions, t: props.t });
        useLayoutEffect(() => {
          latestSearch.current = { query: searchQuery, options: searchOptions, t: props.t };
        }, [searchQuery, searchOptions, props.t]);
        const performSearch = (
          direction: 'previous' | 'next',
          query = latestSearch.current.query,
          options = latestSearch.current.options,
        ) => {
          const search = view.current?.search,
            code = validateTerminalSearch(query, options),
            t = latestSearch.current.t;
          setSearchError(
            code === 'QUERY_TOO_LONG'
              ? t('terminal.searchQueryTooLong', { limit: TERMINAL_SEARCH_QUERY_LIMIT })
              : code === 'REGEX_MATCHES_EMPTY'
                ? t('terminal.searchRegexMatchesEmpty')
                : code
                  ? t('terminal.searchInvalidRegex')
                  : undefined,
          );
          if (!search || !query || code) {
            search?.clearDecorations();
            setSearchResults({ resultIndex: -1, resultCount: 0 });
            return;
          }
          try {
            const addonOptions = {
              ...options,
              incremental: direction === 'previous',
              decorations: {
                matchBackground: '#5c4b16',
                matchBorder: '#f3c409',
                matchOverviewRuler: '#f3c409',
                activeMatchBackground: '#7c2d12',
                activeMatchBorder: '#f97316',
                activeMatchColorOverviewRuler: '#f34309',
              },
            };
            const found =
              direction === 'previous'
                ? search.findPrevious(query, addonOptions)
                : search.findNext(query, addonOptions);
            if (!found) setSearchResults({ resultIndex: -1, resultCount: 0 });
          } catch {
            search.clearDecorations();
            setSearchError(t('terminal.searchUnavailable'));
            setSearchResults({ resultIndex: -1, resultCount: 0 });
          }
        };
        const closeSearch = () => {
          view.current?.search.clearDecorations();
          setSearchOpen(false);
          setSearchError(undefined);
          setSearchResults({ resultIndex: -1, resultCount: 0 });
          view.current?.terminal.focus();
        };
        useEffect(() => {
          if (searchOpen) {
            searchInput.current?.focus();
            searchInput.current?.select();
          }
        }, [searchOpen]);

        const clearPaste = () => {
          pendingPaste.current = undefined;
          setReviewPaste(false);
        };
        useEffect(() => {
          const host = container.current;
          const state = model.getSnapshot();
          const session =
            state.status === 'ready'
              ? state.baseline.sessions.find((item) => item.id === tabId)
              : undefined;
          if (!started || !host || !session || lifetime.signal.aborted) return;
          const gestureGeneration =
            state.status === 'ready' ? state.baseline.generation : undefined;
          setChannelReady(false);
          setExited(false);
          setCapability(undefined);
          setTimestamp(undefined);
          releaseNormalContent();
          setNormalOpen(false);
          const connection = ctx.get('connection') as unknown as ConnectionHandle;
          if (!connection.generation.getSnapshot()) {
            let accepting = true;
            let off = () => {};
            const ready = () => {
              if (accepting && connection.generation.getSnapshot()) {
                accepting = false;
                off();
                clearTimeout(timer);
                setAttempt((value) => value + 1);
              }
            };
            const timer = setTimeout(() => {
              accepting = false;
              off();
              setFailed(true);
            }, 15000);
            off = connection.generation.subscribe(ready);
            ready();
            return () => {
              accepting = false;
              off();
              clearTimeout(timer);
            };
          }
          const terminal = new Terminal({
            ...session.appearance,
            allowProposedApi: true,
            allowTransparency: true,
            scrollback: session.behavior.scrollback,
            wordSeparator: session.behavior.wordSeparator,
            cols: 80,
            rows: 24,
            disableStdin: true,
            theme: {
              background: '#1e1e1e',
              foreground: '#dedede',
              cursor: '#dedede',
              selectionBackground: '#123b34',
            },
          });
          const serialize = new SerializeAddon();
          terminal.loadAddon(serialize);
          const fitter = new FitAddon();
          terminal.loadAddon(fitter);
          const search = new SearchAddon({ highlightLimit: TERMINAL_SEARCH_HIGHLIGHT_LIMIT });
          terminal.loadAddon(search);
          const searchSubscription = search.onDidChangeResults((results) => {
            if (
              view.current?.search !== search ||
              !latestSearch.current.query ||
              validateTerminalSearch(latestSearch.current.query, latestSearch.current.options)
            )
              return;
            setSearchResults(results);
          });
          let suggestionOwner: TerminalSuggestionOwner | undefined;
          let integrationState = 'pending';
          let replaying = false;
          let offSuggestionSettings = () => {};
          let offGestures = () => {};
          let suggestionScroll: { dispose(): void } | undefined;
          const dismissSuggestions = () => suggestionOwner?.dismiss();
          const suggestionPointer = (event: PointerEvent) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.closest('.terminal-suggestions-wrap')
            )
              dismissSuggestions();
          };
          const promptHandler = terminal.parser.registerOscHandler(633, (data) => {
            suggestionOwner?.prompt(data);
            return false;
          });
          const disposeInputHelpers = () => {
            promptHandler.dispose();
            offGestures();
            offGestures = () => {};
            offSuggestionSettings();
            suggestionScroll?.dispose();
            suggestionScroll = undefined;
            document.removeEventListener('pointerdown', suggestionPointer);
            window.removeEventListener('resize', dismissSuggestions);
            if (suggestionOwner) {
              track(suggestionOwner.close());
              if (suggestions.current === suggestionOwner) suggestions.current = undefined;
              suggestionOwner = undefined;
            }
          };
          const directoryHandler = terminal.parser.registerOscHandler(633, (data) => {
            if (!data.startsWith('P;Cwd=')) return false;
            if (replaying) return true;
            const path = directoryFromOsc633(data.slice(6));
            if (path) directories.set(tabId, path);
            return true;
          });
          terminal.open(host);
          const reloadState = reloadStates.consume(tabId);
          if (reloadState?.screen) terminal.write(reloadState.screen);
          let restoreCwd = reloadState?.cwd ? createRestoreCwdInput(reloadState.cwd) : '';
          const restoreDirectory = () => {
            if (
              !restoreCwd ||
              !ready ||
              disposed ||
              terminal.options.disableStdin ||
              lifetime.signal.aborted
            )
              return;
            const input = restoreCwd;
            restoreCwd = '';
            channel.sendInput(input);
          };
          let ready = false;
          let disposed = false;
          let exitObserved = session.state === 'closed';
          const fit = () => {
            if (
              !active.current ||
              host.getBoundingClientRect().width < 1 ||
              host.getBoundingClientRect().height < 1
            )
              return;
            fitter.fit();
            if (ready) channel.resize(terminal.cols, terminal.rows);
          };
          let outputDecoder = createTerminalOutputDecoder(
            encodingOverrides.get(tabId) ?? session.behavior.encoding,
          );
          if (outputDecoder.fellBack)
            setInteractionMessage(
              latestSearch.current.t('terminal.encodingFallback', {
                encoding: session.behavior.encoding,
              }),
            );
          let channel: TerminalStream;
          const sendUserInput = (text: string): boolean => {
            const accepted =
              ready && !disposed && !terminal.options.disableStdin && channel.sendInput(text);
            if (accepted) suggestionOwner?.userInput(text);
            return accepted;
          };

          const outputProjection = new TerminalOutputProjection((metrics) => {
            host.dataset.outputReceivedBytes = String(metrics.receivedBytes);
            host.dataset.outputConsumedBytes = String(metrics.consumedBytes);
            host.dataset.outputPendingBytes = String(metrics.pendingBytes);
            host.dataset.outputPeakPendingBytes = String(metrics.peakPendingBytes);
            host.dataset.outputWriteCalls = String(metrics.writeCalls);
            host.dataset.outputCompletedWrites = String(metrics.completedWrites);
            host.dataset.outputAbandonedBytes = String(metrics.abandonedBytes);
            host.dataset.outputPeakCallbackMs = String(metrics.peakCallbackMs);
          });
          try {
            channel = new TerminalStream(connection, {
              terminalId: tabId,
              writer: { write: (bytes, done) => terminal.write(bytes, done) },
              replay: (value) => {
                replaying = value;
                suggestionOwner?.replay(value);
              },
              decodeOutput: (bytes) => {
                const selected = encodingOverrides.get(tabId) ?? session.behavior.encoding;
                if (outputDecoder.encoding !== selected) {
                  outputDecoder = createTerminalOutputDecoder(selected);
                  if (outputDecoder.fellBack)
                    setInteractionMessage(
                      latestSearch.current.t('terminal.encodingFallback', { encoding: selected }),
                    );
                }
                return decodeTerminalOutput(outputDecoder, bytes, session.behavior.displayRaw);
              },
              progress: outputProjection.update,
              control: (control) => {
                if (control.type === 'exit') {
                  integrationState = 'unavailable';
                  suggestionOwner?.integration(integrationState);
                  exitObserved = true;
                  ready = false;
                  terminal.options.disableStdin = true;
                  setExited(true);
                  setChannelReady(false);
                  setFailed(false);
                }
                if (control.type === 'recording' && control.recording.state === 'error')
                  setInteractionMessage(
                    latestSearch.current.t('terminal.logWriteFailed', {
                      fileName: control.recording.fileName,
                    }),
                  );
                if (control.type === 'shellIntegration') {
                  integrationState = control.state;
                  suggestionOwner?.integration(integrationState);
                  host.dataset.shellIntegration = control.state;
                  if (control.state !== 'pending') restoreDirectory();
                }
                if (control.type === 'ready') {
                  ready = true;
                  setChannelReady(true);
                  terminal.options.disableStdin = session.state === 'closed';
                  drafts.notify(tabId);
                  fit();
                  if (active.current) terminal.focus();
                }
              },
              issue: (issue) => {
                if (disposed) return;
                if (issue === 'TERMINAL_INPUT_TOO_LARGE' || issue === 'TERMINAL_INPUT_QUEUE_FULL')
                  setInputRejected(true);
                else setFailed(true);
              },
              closed: () => {
                integrationState = 'unavailable';
                suggestionOwner?.integration(integrationState);
                ready = false;
                terminal.options.disableStdin = true;
                if (!disposed) {
                  setChannelReady(false);
                  pendingPaste.current = undefined;
                  setReviewPaste(false);
                  setFailed(!exitObserved);
                }
              },
            });
          } catch {
            disposed = true;
            outputProjection.dispose();
            searchSubscription.dispose();
            directoryHandler.dispose();
            disposeInputHelpers();
            terminal.dispose();
            setFailed(true);
            return;
          }
          const acceptPaste = (raw: string) => {
            if (!ready || disposed || terminal.options.disableStdin)
              throw Error('TERMINAL_PASTE_UNAVAILABLE');
            const assessment = assessTerminalPaste(raw, session.behavior.pasteProtection);
            if (assessment.action === 'reject') {
              setInputRejected(true);
              return;
            }
            const text = normalizeTerminalPaste(
              raw,
              session.kind,
              terminalPlatformFromUserAgent(navigator.userAgent),
            );
            if (assessment.action === 'confirm') {
              pendingPaste.current = { text, review: assessment.review };
              setReviewPaste(true);
            } else terminal.paste(text);
          };
          const paste = (event: ClipboardEvent) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!ready || disposed || terminal.options.disableStdin) return;
            acceptPaste(event.clipboardData?.getData('text/plain') ?? '');
          };
          let unregisterInteraction: () => void;
          try {
            unregisterInteraction = interactions.register(tabId, {
              selectionAvailable: () => !disposed && terminal.hasSelection(),
              captureSelection: () => (disposed ? '' : terminal.getSelection()),
              async run(action, signal, captured) {
                const assert = () => {
                  signal.throwIfAborted();
                  if (disposed) throw Error('TERMINAL_VIEW_RETIRED');
                };
                assert();
                setInteractionMessage(undefined);
                setInteractionFeedback(undefined);
                if (action !== 'normal-buffer' && normalSnapshot.current !== undefined)
                  closeNormalBuffer();
                try {
                  if (action === 'search') {
                    setSearchOpen(true);
                    performSearch('next');
                    queueMicrotask(() => {
                      if (!disposed && !signal.aborted) {
                        searchInput.current?.focus();
                        searchInput.current?.select();
                      }
                    });
                  } else if (action === 'explain') {
                    const selection = captured?.selection ?? terminal.getSelection();
                    if (!selection.trim()) {
                      setInteractionMessage(latestSearch.current.t('terminal.noExplainSelection'));
                      return;
                    }
                    const ai = ctx.get('aiTerminalExplanationUi');
                    if (!ai) {
                      setInteractionMessage(latestSearch.current.t('terminal.configureAiFirst'));
                      return;
                    }
                    const facts = model.getSnapshot();
                    if (facts.status !== 'ready') throw Error('TERMINAL_VIEW_RETIRED');
                    const generation = facts.baseline.generation;
                    const outcome = await ai.open(
                      { terminalId: tabId, generation, selection },
                      signal,
                    );
                    if (outcome === 'unconfigured' && !disposed && !signal.aborted)
                      setInteractionMessage(latestSearch.current.t('terminal.configureAiFirst'));
                  } else if (action === 'normal-buffer') {
                    const text = readNormalBuffer(terminal.buffer.normal);
                    if (text === undefined) {
                      setInteractionMessage(latestSearch.current.t('terminal.normalBufferEmpty'));
                      terminal.focus();
                      return;
                    }
                    normalSnapshot.current = text;
                    if (normalElement.current) normalElement.current.textContent = text;
                    setNormalOpen(true);
                  } else if (action === 'clear') {
                    terminal.clear();
                    search.clearDecorations();
                    setSearchResults({ resultIndex: -1, resultCount: 0 });
                  } else if (action === 'select-all') terminal.selectAll();
                  else if (action === 'copy') {
                    const selection = captured?.selection ?? terminal.getSelection();
                    if (!selection || selection.length > 1024 * 1024)
                      throw Error('TERMINAL_SELECTION_UNAVAILABLE');
                    await navigator.clipboard.writeText(selection);
                    assert();
                    setInteractionFeedback(
                      latestSearch.current.t('terminal.copiedCharacters', {
                        count: selection.length,
                      }),
                    );
                  } else if (action === 'paste') {
                    const generation = connection.generation.getSnapshot()?.id;
                    const text = await navigator.clipboard.readText();
                    assert();
                    if (
                      generation === undefined ||
                      connection.generation.getSnapshot()?.id !== generation
                    )
                      throw Error('TERMINAL_VIEW_RETIRED');
                    acceptPaste(text);
                  } else if (action === 'paste-selection') {
                    const text = captured?.selection ?? terminal.getSelection();
                    if (text.length > 1024 * 1024) throw Error('TERMINAL_SELECTION_UNAVAILABLE');
                    acceptPaste(text);
                  } else if (action === 'zoom-in' || action === 'zoom-out') {
                    terminal.options.fontSize = Math.max(
                      8,
                      Math.min(
                        72,
                        (terminal.options.fontSize ?? session.appearance.fontSize) +
                          (action === 'zoom-in' ? 1 : -1),
                      ),
                    );
                    fit();
                  } else throw Error('TERMINAL_VIEW_ACTION_INVALID');
                  if (
                    action !== 'search' &&
                    action !== 'normal-buffer' &&
                    action !== 'explain' &&
                    !disposed
                  )
                    terminal.focus();
                } catch (error) {
                  if (!disposed && !signal.aborted)
                    setInteractionMessage(
                      latestSearch.current.t(
                        action === 'explain'
                          ? 'terminal.explainSelectionError'
                          : action === 'normal-buffer'
                            ? 'metadataUnavailable'
                            : action === 'copy'
                              ? 'terminal.clipboardCopyError'
                              : 'terminal.clipboardPasteError',
                      ),
                    );
                  throw error;
                }
              },
            });
          } catch {
            disposed = true;
            searchSubscription.dispose();
            directoryHandler.dispose();
            disposeInputHelpers();
            channel.dispose();
            outputProjection.dispose();
            terminal.dispose();
            setFailed(true);
            return;
          }
          const compositionGuard = installTerminalCompositionGuard(terminal.textarea);
          let previousCtrlCAt: number | undefined;
          const inputAction = (action: 'copy' | 'paste') => {
            void Promise.resolve()
              .then(() => interactions.run(tabId, action))
              .catch(() => {});
          };
          offGestures = installTerminalGestures(host, {
            platform: ctx.shortcuts.platform,
            current: () => {
              const current = model.getSnapshot(),
                settings = ctx.configurationActions.getSnapshot();
              return ready &&
                !disposed &&
                active.current &&
                current.status === 'ready' &&
                current.baseline.generation === gestureGeneration &&
                current.baseline.sessions.some((value) => value.id === tabId) &&
                settings.status === 'ready' &&
                settings.baseline.generation === gestureGeneration
                ? settings.baseline.settings.shortcuts.bindings
                : undefined;
            },
            run: (action) => track(interactions.run(tabId, action)),
          });
          terminal.attachCustomKeyEventHandler((event) => {
            const composition = compositionGuard.handleKey(event);
            if (composition !== undefined) {
              event.stopPropagation();
              return composition;
            }
            if (terminalDefersApplicationShortcut(event, ctx.shortcuts.fixedCatalog.getSnapshot()))
              return false;
            const platform = terminalPlatformFromUserAgent(navigator.userAgent);
            const clipboard = terminalClipboardShortcut(event, platform, terminal.hasSelection());
            if (clipboard) {
              event.preventDefault();
              event.stopPropagation();
              if (event.type === 'keydown' && !event.repeat) inputAction(clipboard);
              return false;
            }
            const windows = platform === 'win32';
            if (
              windows &&
              event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              ['c', 'v'].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (event.type === 'keydown' && !event.repeat) {
                if (event.key.toLowerCase() === 'v') {
                  previousCtrlCAt = undefined;
                  inputAction('paste');
                } else if (event.shiftKey) {
                  previousCtrlCAt = undefined;
                  inputAction('copy');
                } else {
                  const press = terminalCtrlCPress(
                    previousCtrlCAt,
                    performance.now(),
                    terminal.hasSelection(),
                  );
                  previousCtrlCAt = press.nextPressAt;
                  if (press.action === 'copy') inputAction('copy');
                  else if (ready && !disposed && !terminal.options.disableStdin) {
                    sendUserInput('\x03');
                    terminal.scrollToBottom();
                  }
                }
              }
              return false;
            }
            if (
              event.type === 'keydown' &&
              !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
            )
              previousCtrlCAt = undefined;
            if (suggestionOwner?.key(event)) {
              event.preventDefault();
              event.stopPropagation();
              return false;
            }
            if (
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              (event.key === 'Backspace' || (event.key === 'Enter' && event.shiftKey))
            ) {
              if (
                event.type === 'keydown' &&
                ready &&
                !disposed &&
                !terminal.options.disableStdin
              ) {
                sendUserInput(
                  event.key === 'Backspace'
                    ? terminalBackspaceSequence(session.behavior.backspaceMode, event.shiftKey)
                    : terminalShiftEnterSequence(session.behavior.shiftEnterMode),
                );
                terminal.scrollToBottom();
              }
              return false;
            }
            if (event.type !== 'keydown') return true;
            return true;
          });
          host.addEventListener('paste', paste, true);
          let draftInput: { seen: boolean; accepted: boolean } | undefined;
          const input = terminal.onData((text) => {
            const accepted = sendUserInput(text);
            if (draftInput) {
              draftInput.seen = true;
              draftInput.accepted &&= accepted;
            }
          });
          let unregisterDraft: () => void;
          try {
            unregisterDraft = drafts.register(tabId, () =>
              ready && active.current && !disposed && !terminal.options.disableStdin
                ? {
                    bracketedPaste:
                      terminal.modes.bracketedPasteMode &&
                      terminal.options.ignoreBracketedPasteMode !== true,
                    paste: (text) => {
                      const result = { seen: false, accepted: true };
                      draftInput = result;
                      try {
                        terminal.paste(text);
                        return result.seen && result.accepted;
                      } finally {
                        draftInput = undefined;
                      }
                    },
                    focus: () => terminal.focus(),
                  }
                : undefined,
            );
          } catch {
            disposed = true;
            unregisterInteraction();
            compositionGuard.dispose();
            releaseNormalContent();
            searchSubscription.dispose();
            input.dispose();
            directoryHandler.dispose();
            disposeInputHelpers();
            directories.delete(tabId);
            channel.dispose();
            terminal.dispose();
            setFailed(true);
            return;
          }
          const capabilities = installTerminalCapabilities(terminal, session.behavior, {
            onState: setCapability,
            feedback(code) {
              const key =
                code === 'WEBGL_CONTEXT_LOST'
                  ? 'terminal.webglContextLost'
                  : code === 'WEBGL_UNAVAILABLE'
                    ? 'terminal.webglUnavailable'
                    : code === 'UNICODE_11_UNAVAILABLE'
                      ? 'terminal.unicode11Unavailable'
                      : code === 'LIGATURES_UNAVAILABLE'
                        ? 'terminal.ligaturesUnavailable'
                        : 'terminal.imagesUnavailable';
              setInteractionMessage(latestSearch.current.t(key));
            },
          });
          track(capabilities.ready);
          const links = new WebLinksAddon((_event, uri) => {
            if (disposed) return;
            const failed = () => {
              if (!disposed) setInteractionMessage(latestSearch.current.t('terminal.unsafeLink'));
            };
            try {
              void track(ctx.desktopUi.openExternal(uri)).catch(failed);
            } catch {
              failed();
            }
          });
          terminal.loadAddon(links);
          let pointer = { x: 0, y: 0 };
          const rememberPointer = (event: MouseEvent) => {
            pointer = { x: event.clientX, y: event.clientY };
          };
          const dismissTimestamp = () => {
            if (!disposed) setTimestamp(undefined);
          };
          const selectionChange = terminal.onSelectionChange(() => {
            const position = terminal.getSelectionPosition();
            const visible =
              active.current &&
              host.isConnected &&
              !host.closest('[hidden]') &&
              host.getBoundingClientRect().width > 0;
            const text =
              visible &&
              position &&
              position.start.y === position.end.y &&
              position.end.x - position.start.x <= 64
                ? formatUnixTimestampSelection(terminal.getSelection())
                : undefined;
            setTimestamp(text ? { text, pointer: { ...pointer } } : undefined);
          });
          host.addEventListener('mousemove', rememberPointer);
          host.addEventListener('mouseleave', dismissTimestamp);
          host.addEventListener('keydown', dismissTimestamp);
          host.addEventListener('blur', dismissTimestamp, true);
          window.addEventListener('resize', dismissTimestamp);
          const selectionScroll = terminal.onScroll(dismissTimestamp);
          const capture = () => {
            let screen = '';
            try {
              screen = serialize.serialize({
                scrollback: session.behavior.scrollback,
                excludeAltBuffer: true,
                excludeModes: true,
              });
            } catch {
              /* Closing views have no recoverable screen. */
            }
            return createTerminalReloadState({
              cwd: directories.get(tabId),
              screen,
              alternateScreen: getAlternateBufferSnapshot(terminal.buffer.active),
            });
          };
          captures.set(tabId, capture);
          const sendOwned = (text: string) =>
            ready && !disposed && !terminal.options.disableStdin && channel.sendInput(text);
          suggestionOwner = new TerminalSuggestionOwner({
            id: tabId,
            generation: state.status === 'ready' ? state.baseline.generation : '',
            sessions: model,
            facts: ctx.terminalFactsModel,
            enabled: () => {
              const current = ctx.configurationActions.getSnapshot();
              return (
                current.status === 'ready' &&
                current.baseline.generation === registeredGeneration &&
                current.baseline.settings.terminal.commandSuggestionsEnabled
              );
            },
            active: () => active.current,
            position: () =>
              host.parentElement
                ? terminalCommandSuggestionPosition(terminal, host.parentElement)
                : undefined,
            ai: () => ctx.get('aiCommandSuggestionsUi'),
            remove: async (item, generation) => {
              const owner = ctx.get('terminalHistoryUi');
              if (!owner) throw Error('TERMINAL_HISTORY_UNAVAILABLE');
              await owner.remove(item.id, item.version, generation);
            },
            send: sendUserInput,
            focus: () => {
              if (active.current && !disposed) terminal.focus();
            },
            t: latestSearch.current.t,
            changed: (value) => {
              if (!disposed) setSuggestionState(value);
            },
          });
          suggestionOwner.integration(integrationState);
          suggestionOwner.replay(replaying);
          suggestions.current = suggestionOwner;
          setSuggestionState(undefined);
          const applyBehaviorPreferences = () => {
            const current = ctx.configurationActions.getSnapshot();
            if (
              !disposed &&
              current.status === 'ready' &&
              current.baseline.generation === registeredGeneration
            )
              terminal.options.screenReaderMode =
                current.baseline.settings.terminal.screenReaderMode;
            suggestionOwner?.updated();
          };
          offSuggestionSettings = ctx.configurationActions.subscribe(applyBehaviorPreferences);
          applyBehaviorPreferences();
          suggestionScroll = terminal.onScroll(dismissSuggestions);
          document.addEventListener('pointerdown', suggestionPointer);
          window.addEventListener('resize', dismissSuggestions);
          const osc52 = new Osc52Addon({
            policy: session.behavior,
            sendData: sendOwned,
            getClipboard: () => navigator.clipboard,
            feedback(code) {
              const keys = {
                DISABLED: 'terminal.osc52Disabled',
                MALFORMED_REQUEST: 'terminal.osc52Malformed',
                UNSUPPORTED_TARGET: 'terminal.osc52UnsupportedTarget',
                READ_DENIED: 'terminal.osc52ReadDenied',
                WRITE_DENIED: 'terminal.osc52WriteDenied',
                INVALID_BASE64: 'terminal.osc52InvalidBase64',
                INVALID_UTF8: 'terminal.osc52InvalidUtf8',
                PAYLOAD_TOO_LARGE: 'terminal.osc52PayloadTooLarge',
                RESPONSE_TOO_LARGE: 'terminal.osc52ResponseTooLarge',
                CLIPBOARD_BUSY: 'terminal.osc52ClipboardBusy',
                CLIPBOARD_UNAVAILABLE: 'terminal.clipboardUnavailable',
                CLIPBOARD_TIMEOUT: 'terminal.osc52ClipboardTimeout',
                CLIPBOARD_FAILED: 'terminal.osc52ClipboardFailed',
                INPUT_UNAVAILABLE: 'terminal.osc52InputUnavailable',
                READ_SUCCEEDED: 'terminal.osc52ReadSucceeded',
                WRITE_SUCCEEDED: 'terminal.osc52WriteSucceeded',
              } as const;
              setInteractionMessage(latestSearch.current.t(keys[code]));
            },
          });
          terminal.loadAddon(osc52);
          inputSinks.set(tabId, sendUserInput);
          const droppedFiles = new TerminalFileDropOwner({
            target: () => {
              const current = model.getSnapshot(),
                config = ctx.configurationActions.getSnapshot();
              if (
                disposed ||
                !active.current ||
                !ready ||
                lifetime.signal.aborted ||
                current.status !== 'ready' ||
                config.status !== 'ready' ||
                config.baseline.generation !== current.baseline.generation
              )
                return;
              const currentSession = current.baseline.sessions.find(
                (item) => item.id === tabId && item.state === 'ready',
              );
              if (!currentSession) return;
              return {
                generation: current.baseline.generation,
                id: tabId,
                kind: currentSession.kind,
                ...(currentSession.connectionId
                  ? { connectionId: currentSession.connectionId }
                  : {}),
                cwd: directories.get(tabId) ?? '',
                behavior: config.baseline.settings.terminal.dragDropBehavior,
              };
            },
            files: ctx.fileGrantActions,
            handoff: () => ctx.get('fileTransferActions'),
            send: sendUserInput,
            notify: (key, params) => {
              if (!disposed) {
                setInteractionMessage(latestSearch.current.t(key, params));
                if (active.current) terminal.focus();
              }
            },
            changed: (value) => {
              if (!disposed) setDropState(value);
            },
          });
          dropOwner.current = droppedFiles;
          const nativeDirectoryDrop = (event: MessageEvent) => {
            if (
              event.source !== window ||
              event.origin !== location.origin ||
              event.data?.type !== 'axterm:native-directory-drop' ||
              event.data.ownerToken !== tabId
            )
              return;
            if (disposed || !active.current) return;
            dragDepth.current = 0;
            setDropActive(false);
            if (event.data.failed === true) {
              setInteractionMessage(latestSearch.current.t('insertPathsError'));
              return;
            }
            const tickets = event.data.tickets;
            if (!Array.isArray(tickets) || tickets.some((ticket) => typeof ticket !== 'string'))
              return;
            try {
              void track(droppedFiles.directories(tickets)).catch(() => {
                if (!disposed) setInteractionMessage(latestSearch.current.t('insertPathsError'));
              });
            } catch {
              setInteractionMessage(latestSearch.current.t('insertPathsError'));
            }
          };
          window.addEventListener('message', nativeDirectoryDrop);
          const sendShortcut = (data: string) =>
            sendUserInput(
              resolveTerminalShortcutCursorMode(data, terminal.modes.applicationCursorKeysMode),
            );
          shortcutSinks.set(tabId, sendShortcut);
          const resize = new ResizeObserver(fit);
          resize.observe(host);
          view.current = { terminal, fit, search };
          fit();
          const disposeView = () => {
            if (disposed) return;
            disposed = true;
            window.removeEventListener('message', nativeDirectoryDrop);
            if (dropOwner.current === droppedFiles) dropOwner.current = undefined;
            track(droppedFiles.close());
            unregisterDraft();
            unregisterInteraction();
            restoreCwd = '';
            if (captures.get(tabId) === capture) captures.delete(tabId);
            capabilities.dispose();
            osc52.dispose();
            track(osc52.drain());
            compositionGuard.dispose();
            selectionChange.dispose();
            selectionScroll.dispose();
            host.removeEventListener('mousemove', rememberPointer);
            host.removeEventListener('mouseleave', dismissTimestamp);
            host.removeEventListener('keydown', dismissTimestamp);
            host.removeEventListener('blur', dismissTimestamp, true);
            window.removeEventListener('resize', dismissTimestamp);
            releaseNormalContent();
            searchSubscription.dispose();
            if (inputSinks.get(tabId) === sendUserInput) inputSinks.delete(tabId);
            if (shortcutSinks.get(tabId) === sendShortcut) shortcutSinks.delete(tabId);
            pendingPaste.current = undefined;
            host.removeEventListener('paste', paste, true);
            view.current = undefined;
            resize.disconnect();
            input.dispose();
            directoryHandler.dispose();
            disposeInputHelpers();
            directories.delete(tabId);
            channel.dispose();
            terminal.dispose();
            views.delete(disposeView);
          };
          views.add(disposeView);
          if (lifetime.signal.aborted) disposeView();
          return disposeView;
        }, [tabId, attempt, started, carrierGeneration, closeNormalBuffer, releaseNormalContent]);
        useEffect(() => {
          const terminal = view.current?.terminal;
          if (!terminal) return;
          terminal.options.theme = {
            background: '#1e1e1e',
            foreground: '#dedede',
            cursor: '#dedede',
            selectionBackground: '#123b34',
            ...appearance.theme,
            ...(appearance.background.kind === 'none' ? {} : { background: '#00000000' }),
          };
        }, [appearance.theme, appearance.background.kind, attempt, channelReady]);
        useEffect(() => {
          if (props.active && !filesOpen) {
            view.current?.fit();
            drafts.notify(tabId);
            if (normalOpen) normalClose.current?.focus();
            else if (searchOpen) searchInput.current?.focus();
            else view.current?.terminal.focus();
          } else {
            pendingPaste.current = undefined;
            setReviewPaste(false);
            if (dropOwner.current) void track(dropOwner.current.cancel()).catch(() => {});
            dragDepth.current = 0;
            setDropActive(false);
          }
        }, [props.active, filesOpen, normalOpen, searchOpen, tabId]);
        return (
          <Tabs
            activationMode="manual"
            value={filesOpen ? 'files' : 'terminal'}
            onValueChange={selectMode}
            className={cx('terminal-view')}
            style={{
              backgroundColor: appearance.theme?.background ?? 'var(--ax-color-terminal-canvas)',
            }}
            data-background-kind={appearance.background.kind}
            data-terminal-id={props.tabId}
            data-terminal-carrier={carrierGeneration?.id}
            data-axterm-directory-drop={props.active && !filesOpen ? props.tabId : undefined}
            data-file-drop={
              dropState.phase === 'preparing'
                ? 'preparing'
                : dropState.phase === 'asking'
                  ? 'asking'
                  : dropActive
                    ? 'active'
                    : 'idle'
            }
            onDragEnter={(event) => {
              if (!active.current || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              dragDepth.current++;
              setDropActive(true);
            }}
            onDragOver={(event) => {
              if (!active.current || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (!active.current || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (!dragDepth.current) setDropActive(false);
            }}
            onDrop={(event) => {
              if (!active.current || !event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              event.stopPropagation();
              dragDepth.current = 0;
              setDropActive(false);
              const files = [...event.dataTransfer.files],
                directory = [...event.dataTransfer.items].some(
                  (item) => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory,
                );
              runDrop(() => {
                if (!dropOwner.current) throw Error('TERMINAL_DROP_NOT_READY');
                return dropOwner.current.files(files, directory);
              });
            }}
            data-terminal-channel={
              session?.state === 'closed' || exited
                ? 'closed'
                : channelReady
                  ? 'ready'
                  : 'connecting'
            }
            data-terminal-capabilities={capability?.ready ? 'ready' : 'loading'}
            data-terminal-renderer={capability?.renderer}
            data-terminal-unicode={capability?.unicodeVersion}
            data-terminal-ligatures={capability?.ligatures}
            data-terminal-images={capability?.images}
            data-encoding={encoding}
            data-display-raw={session?.behavior.displayRaw}
            data-recording={session?.recording?.state === 'active'}
            data-command-suggestions={suggestionState ? 'open' : 'closed'}
            aria-busy={!channelReady}
            onKeyDownCapture={(event) => {
              if (normalOpen && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeNormalBuffer();
              }
            }}
          >
            <header className={cx('terminal-session-toolbar')}>
              <TabsList className={cx('session-mode-tabs')} aria-label={props.t('sessionTools')}>
                <TabsTrigger
                  value="terminal"
                  onClick={() => {
                    view.current?.fit();
                    view.current?.terminal.focus();
                  }}
                >
                  {session?.kind === 'ssh' ? 'SSH' : props.t('terminalMode')}
                </TabsTrigger>
                {(session?.kind === 'local' || session?.kind === 'ssh') && (
                  <TabsTrigger value="files" disabled={!filesAvailable || filesBusy}>
                    {session.kind === 'ssh' ? 'SFTP' : props.t('filesMode')}
                  </TabsTrigger>
                )}
              </TabsList>
              <span
                className={cx(
                  'session-state',
                  ...(session?.state === 'closed' ? ['disconnected'] : []),
                )}
              />
              <select
                aria-label={props.t('paneSession', {
                  number:
                    (workspaceState.tabs.find((tab) => tab.id === props.tabId)?.paneIndex ?? 0) + 1,
                })}
                value={props.tabId}
                onChange={(event) => {
                  const pane =
                    workspaceState.tabs.find((tab) => tab.id === props.tabId)?.paneIndex ?? 0;
                  workspace.arrange?.moveToPane(event.target.value, pane);
                }}
              >
                {workspaceState.tabs.map((tab) => (
                  <option key={tab.id} value={tab.id}>
                    {tab.title}
                  </option>
                ))}
              </select>
              <div className={cx('session-pane-actions')}>
                <button
                  type="button"
                  aria-label={props.t('searchTerminal')}
                  onClick={() => {
                    setFilesOpen(false);
                    setSearchOpen(true);
                  }}
                >
                  <Search size={12} />
                </button>
                <button
                  type="button"
                  aria-label={props.t('maximizePane')}
                  aria-pressed={workspaceState.arrangement?.maximizedPane !== undefined}
                  onClick={() => {
                    const pane =
                      workspaceState.tabs.find((tab) => tab.id === props.tabId)?.paneIndex ?? 0;
                    workspace.arrange?.maximizePane(
                      workspaceState.arrangement?.maximizedPane === pane ? undefined : pane,
                    );
                  }}
                >
                  {workspaceState.arrangement?.maximizedPane !== undefined ? (
                    <Minimize2 size={12} />
                  ) : (
                    <Maximize2 size={12} />
                  )}
                </button>
              </div>
            </header>
            {filesFailed && (
              <div role="alert" className={cx('terminal-files-error')}>
                {props.t('filePaneUnavailable')}
              </div>
            )}
            <TabsContent
              value="files"
              forceMount
              hidden={!filesOpen}
              className={cx('terminal-files-content')}
            >
              {filesPrepared &&
                props.renderSlot('terminal.files', {
                  tabId: props.tabId,
                  active: props.active && filesOpen,
                })}
            </TabsContent>
            <TabsContent
              value="terminal"
              forceMount
              hidden={filesOpen}
              className={cx('terminal-content')}
              style={{
                backgroundColor: appearance.theme?.background ?? 'var(--ax-color-terminal-canvas)',
              }}
            >
              {appearance.background.kind !== 'none' && (
                <div
                  className={cx(
                    'terminal-background',
                    `terminal-background-${appearance.background.kind}`,
                  )}
                  aria-hidden="true"
                  data-background-state={
                    appearance.imageFailed
                      ? 'unavailable'
                      : appearance.background.kind === 'image' && !appearance.imageUrl
                        ? 'loading'
                        : 'ready'
                  }
                  style={{
                    opacity: appearance.background.opacity,
                    filter: `blur(${appearance.background.blur}px) brightness(${appearance.background.brightness}) grayscale(${appearance.background.grayscale}) contrast(${appearance.background.contrast})`,
                    ...(appearance.imageUrl
                      ? { backgroundImage: `url(${JSON.stringify(appearance.imageUrl)})` }
                      : {}),
                  }}
                >
                  {appearance.background.kind === 'text' && (
                    <span
                      style={{
                        color: appearance.background.textColor,
                        fontFamily: appearance.background.textFontFamily,
                        fontSize: `${appearance.background.textSize}px`,
                      }}
                    >
                      {appearance.background.text}
                    </span>
                  )}
                </div>
              )}
              <div ref={container} className={cx('terminal-canvas')} />
              {appearance.imageFailed && (
                <div className={cx('terminal-recovery')} role="alert">
                  {props.t('backgroundUnavailable')}
                </div>
              )}
              {normalOpen && (
                <section
                  className={
                    'terminal-normal-buffer ' + (interactionStyles['terminal-normal-buffer'] ?? '')
                  }
                  aria-label={props.t('terminal.normalBuffer')}
                >
                  <pre ref={normalElement} />
                  <footer>
                    <span>{props.t('terminal.normalBuffer')}</span>
                    <button
                      ref={normalClose}
                      type="button"
                      aria-label={props.t('terminal.closeNormalBuffer')}
                      onClick={closeNormalBuffer}
                    >
                      ×
                    </button>
                  </footer>
                </section>
              )}
              {session?.recording?.state === 'active' && (
                <button
                  type="button"
                  className={
                    'terminal-recording-indicator ' +
                    (toolStyles['terminal-recording-indicator'] ?? '')
                  }
                  aria-label={props.t('terminal.stopRecordingLog', {
                    fileName: session.recording.fileName,
                  })}
                  disabled={recordingState.busy.includes(props.tabId)}
                  onClick={() => {
                    void tools.recording.run(props.tabId).catch(() => {});
                  }}
                >
                  <span aria-hidden="true" />
                  {props.t('terminal.recordingLog', { fileName: session.recording.fileName })}
                </button>
              )}
              {suggestionState && props.active && (
                <TerminalCommandSuggestions
                  state={suggestionState}
                  x={props.t}
                  onSelect={(item) => suggestions.current?.select(item)}
                  onDelete={(item) => {
                    void suggestions.current?.remove(item).catch(() => {});
                  }}
                  onRequestAi={() => {
                    void suggestions.current?.requestAi().catch(() => {});
                  }}
                />
              )}
              {props.active && timestamp && <TerminalTimestampTooltip {...timestamp} />}
              {searchOpen && (
                <TerminalSearchBar
                  x={props.t}
                  inputRef={searchInput}
                  query={searchQuery}
                  options={searchOptions}
                  results={searchResults}
                  error={searchError}
                  onQueryChange={(value) => {
                    latestSearch.current = { ...latestSearch.current, query: value };
                    setSearchQuery(value);
                    performSearch('next', value);
                  }}
                  onOptionChange={(key) => {
                    const next = toggleTerminalSearchOption(searchOptions, key);
                    latestSearch.current = { ...latestSearch.current, options: next };
                    setSearchOptions(next);
                    performSearch('next', searchQuery, next);
                  }}
                  onPrevious={() => performSearch('previous')}
                  onNext={() => performSearch('next')}
                  onClose={closeSearch}
                />
              )}
              {interactionFeedback && (
                <div
                  className={
                    'terminal-action-feedback interaction-feedback ' +
                    (interactionStyles['interaction-feedback'] ?? '')
                  }
                  role="status"
                >
                  {interactionFeedback}
                </div>
              )}
              {interactionMessage && (
                <div
                  className={
                    'interaction-feedback ' + (interactionStyles['interaction-feedback'] ?? '')
                  }
                  role="alert"
                >
                  {interactionMessage}
                  <button
                    aria-label={props.t('dismiss')}
                    onClick={() => setInteractionMessage(undefined)}
                  >
                    ×
                  </button>
                </div>
              )}

              {props.active && dropActive && (
                <div className={dropCx('terminal-file-drop-target')} aria-hidden="true">
                  <strong>{props.t('releaseFiles')}</strong>
                  <span>{props.t('sendToCurrent')}</span>
                </div>
              )}
              {(dropState.phase === 'preparing' || dropState.phase === 'acting') && (
                <div
                  className={dropCx('terminal-file-drop-preparing')}
                  role="status"
                  aria-live="polite"
                >
                  <span>{props.t('preparingFiles', { count: dropState.names.length })}</span>
                  <button
                    type="button"
                    onClick={() => runDrop(() => dropOwner.current?.cancel() ?? Promise.resolve())}
                  >
                    {props.t('cancel')}
                  </button>
                </div>
              )}
              {dropState.phase === 'asking' && (
                <TerminalFileDropDialog
                  t={props.t}
                  names={dropState.names}
                  canUpload={dropState.canUpload}
                  onSelect={(action) =>
                    runDrop(() => {
                      if (!dropOwner.current) throw Error('TERMINAL_DROP_NOT_READY');
                      return dropOwner.current.select(action);
                    })
                  }
                  onCancel={() => runDrop(() => dropOwner.current?.cancel() ?? Promise.resolve())}
                />
              )}
              {reviewPaste && pendingPaste.current && (
                <TerminalPasteDialog
                  t={props.t}
                  localeId={ctx.locale.getLocale().active}
                  review={pendingPaste.current.review}
                  cancel={clearPaste}
                  confirm={() => {
                    const text = pendingPaste.current?.text;
                    clearPaste();
                    if (text !== undefined) view.current?.terminal.paste(text);
                  }}
                />
              )}
              {inputRejected && (
                <div className={cx('terminal-recovery')} role="alert">
                  {props.t('inputRejected')}{' '}
                  <Button variant="ghost" onClick={() => setInputRejected(false)}>
                    {props.t('dismiss')}
                  </Button>
                </div>
              )}
              <TerminalReconnectOverlay
                x={props.t}
                connection={connection}
                retrying={sessionActions.busy.includes(props.tabId) && sessionCommand !== 'cancel'}
                canceling={sessionActions.busy.includes(props.tabId) && sessionCommand === 'cancel'}
                onRetry={() => runSession('reload')}
                onCancel={() => runSession('cancel')}
              />
              {(session?.state === 'closed' || exited) &&
              !terminalReconnectPresentation(connection) ? (
                <div className={cx('terminal-recovery')} role="status">
                  {props.t('terminal.disconnected')}{' '}
                  <Button
                    variant="ghost"
                    disabled={
                      sessionActions.busy.includes(props.tabId) ||
                      sessionActions.uncertain.includes(props.tabId)
                    }
                    onClick={() => runSession('reload')}
                  >
                    {props.t('terminal.reconnectNow')}
                  </Button>
                </div>
              ) : (
                !terminalReconnectPresentation(connection) &&
                failed && (
                  <div className={cx('terminal-recovery')} role="alert">
                    {props.t('streamUnavailable')}{' '}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setFailed(false);
                        setAttempt((value) => value + 1);
                      }}
                    >
                      {props.t('reconnectStream')}
                    </Button>
                  </div>
                )
              )}
            </TabsContent>
          </Tabs>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'terminals.status', order: 80, locale: 'terminals' },
      function Status({ t }: PropsLocale<'terminals'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          layout = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
        useSyncExternalStore(subscribeEncoding, encodingSnapshot);
        const session =
          state.status === 'ready'
            ? state.baseline.sessions.find((item) => item.id === layout.activeTabId)
            : undefined;
        if (!session) return null;
        return (
          <>
            <span data-terminal-kind="">
              {session.kind === 'local' ? 'Local PTY' : session.kind.toUpperCase()}
            </span>
            {session.state === 'ready' && (
              <label className={styles['status-encoding']}>
                <span>{t('status.encoding')}</span>
                <select
                  aria-label={t('status.currentEncoding')}
                  value={encodingOverrides.get(session.id) ?? session.behavior.encoding}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    const current = model.getSnapshot();
                    if (
                      current.status !== 'ready' ||
                      state.status !== 'ready' ||
                      current.baseline.generation !== state.baseline.generation ||
                      !current.baseline.sessions.some(
                        (item) => item.id === session.id && item.state === 'ready',
                      ) ||
                      !TERMINAL_ENCODINGS.some((encoding) => encoding === value)
                    )
                      return;
                    if (!encodingOverrides.has(session.id) && encodingOverrides.size >= 128) return;
                    encodingOverrides.set(session.id, value as TerminalBehavior['encoding']);
                    encodingChanged();
                  }}
                >
                  {TERMINAL_ENCODINGS.map((encoding) => (
                    <option key={encoding} value={encoding}>
                      {encoding.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        );
      },
    );
  });
}
