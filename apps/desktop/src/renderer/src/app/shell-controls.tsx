import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { createRuntimeClient } from '@workspace/client';
import type {
  Connection,
  Host,
  Settings,
  TerminalBehavior,
  TerminalTheme,
  TerminalVisualSettings,
  TerminalProfile,
} from '@workspace/contracts';
import { parseQuickConnect, type QuickConnectTarget } from '@workspace/shared';
import {
  ArrowRight,
  Bot,
  CircleHelp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Minus,
  Pin,
  Plus,
  Save,
  Scan,
  Search,
  Server,
  SplitSquareHorizontal,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { TerminalView, type TerminalViewHandle } from '../components/terminal-view';
import { RdpView } from '../components/rdp-view';
import { VncView } from '../components/vnc-view';
import { SpiceView } from '../components/spice-view';
import { WebSessionView } from '../components/web-session-view';
import { TerminalReconnectOverlay } from '../components/terminal-reconnect-overlay';
import type { TerminalReloadState } from '../components/terminal-reload-state';
import { maskHostAddress } from './privacy';
import {
  paneCount,
  paneOf,
  paneTabsInDisplayOrder,
  type TerminalTab,
  type TerminalSessionMode,
  type WorkspaceLayoutMode,
} from '../stores/workspace';
import { useI18n } from '../i18n/context';

export type NamedWorkspace = Settings['workspace']['namedWorkspaces'][number];

function focusTerminalTab(parent: HTMLElement | null, terminalId: string) {
  // TerminalView fits and focuses the newly active xterm in its own animation
  // frame. A second frame restores the roving-tab focus for keyboard actions.
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      Array.from(parent?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
        .find((element) => element.dataset.terminalId === terminalId)
        ?.focus(),
    ),
  );
}

function handleTerminalTabKey(
  event: ReactKeyboardEvent<HTMLDivElement>,
  tab: TerminalTab,
  tabs: TerminalTab[],
  onActivate: (id: string) => void,
  onMoveTab: (id: string, targetId: string, after: boolean) => void,
) {
  const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
  if (direction && event.altKey && event.shiftKey) {
    const movable = tabs.filter((candidate) => !!candidate.pinned === !!tab.pinned);
    const index = movable.findIndex((candidate) => candidate.id === tab.id);
    const target = movable[index + direction];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const parent = event.currentTarget.parentElement;
    onMoveTab(tab.id, target.id, direction > 0);
    onActivate(tab.id);
    focusTerminalTab(parent, tab.id);
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onActivate(tab.id);
    return;
  }
  const current = tabs.findIndex((candidate) => candidate.id === tab.id);
  const targetIndex =
    direction !== 0
      ? (current + direction + tabs.length) % tabs.length
      : event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : -1;
  const target = tabs[targetIndex];
  if (targetIndex < 0 || !target) return;
  event.preventDefault();
  onActivate(target.id);
  const parent = event.currentTarget.parentElement;
  focusTerminalTab(parent, target.id);
}

const layoutChoices: Array<{
  id: WorkspaceLayoutMode;
  labelKey: string;
  className: string;
}> = [
  { id: 'c1', labelKey: 'single', className: 'layout-c1' },
  { id: 'c2', labelKey: 'twoColumns', className: 'layout-c2' },
  { id: 'r2', labelKey: 'twoRows', className: 'layout-r2' },
  { id: 'c3', labelKey: 'threeColumns', className: 'layout-c3' },
  { id: 'r3', labelKey: 'threeRows', className: 'layout-r3' },
  { id: 'c2x2', labelKey: 'grid2x2', className: 'layout-c2x2' },
  { id: 'c1r2', labelKey: 'twoRowsRight', className: 'layout-c1r2' },
  { id: 'r1c2', labelKey: 'twoColumnsBottom', className: 'layout-r1c2' },
];

function MenuSurface({
  className,
  style,
  onDismiss,
  children,
}: {
  className: string;
  style?: CSSProperties | undefined;
  onDismiss(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', onDismiss);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss]);
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}

export function NewSessionMenu({
  hosts,
  hideAddresses = false,
  profiles,
  defaultProfileId,
  onLocal,
  onHost,
  onQuickConnect,
  onOpenBookmarks,
  onDismiss,
}: {
  hosts: Host[];
  hideAddresses?: boolean;
  profiles: TerminalProfile[];
  defaultProfileId?: string | null | undefined;
  onLocal(profileId?: string): void;
  onHost(host: Host, profileId?: string): void;
  onQuickConnect(target: QuickConnectTarget, profileId?: string): void;
  onOpenBookmarks(): void;
  onDismiss(): void;
}) {
  const { t, x } = useI18n();
  const [quickConnect, setQuickConnect] = useState('');
  const [profileId, setProfileId] = useState('');
  const [error, setError] = useState('');
  const defaultProfile = profiles.find((profile) => profile.id === defaultProfileId);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const recentHosts = [...hosts]
    .sort(
      (left, right) =>
        Number(right.favorite) - Number(left.favorite) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 6);

  const submit = () => {
    const target = parseQuickConnect(quickConnect);
    if (!target) {
      setError(x('shell.quickConnectInput'));
      return;
    }
    onQuickConnect(target, profileId || undefined);
    onDismiss();
  };

  return (
    <MenuSurface className="session-menu popover-surface" onDismiss={onDismiss}>
      <header>
        <strong>{t('newTerminal', 'New session')}</strong>
        <small>LOCAL & REMOTE</small>
      </header>
      <button
        className="menu-primary-row"
        onClick={() => {
          onLocal(profileId || undefined);
          onDismiss();
        }}
      >
        <Terminal size={15} />
        <span>
          <strong>{x('shell.localTerminal')}</strong>
          <small>
            {selectedProfile?.name ??
              (defaultProfile
                ? x('shell.defaultProfile', { name: defaultProfile.name })
                : x('shell.platformDefaultShell'))}
          </small>
        </span>
        <kbd>⌘T</kbd>
      </button>
      <div className="quick-connect-box">
        <label htmlFor="terminal-profile">{x('shell.terminalProfile')}</label>
        <div className="session-profile-row">
          <Terminal size={13} />
          <select
            id="terminal-profile"
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            <option value="">
              {defaultProfile
                ? x('shell.globalDefault', { name: defaultProfile.name })
                : x('shell.platformDefault')}
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor="quick-connect">Quick Connect</label>
        <div>
          <Zap size={14} />
          <input
            id="quick-connect"
            autoFocus
            value={quickConnect}
            placeholder="user@host:22"
            onChange={(event) => {
              setQuickConnect(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <button onClick={submit} aria-label={t('connect', 'Connect')}>
            <ArrowRight size={14} />
          </button>
        </div>
        {error && <small className="menu-error">{error}</small>}
      </div>
      <div className="menu-section-label">
        <span>{t('bookmarks', 'Bookmarks')}</span>
        <button onClick={onOpenBookmarks}>{x('shell.manage')}</button>
      </div>
      <div className="session-menu-hosts">
        {recentHosts.map((host) => (
          <button
            key={host.id}
            onClick={() => {
              onHost(host, profileId || undefined);
              onDismiss();
            }}
          >
            <span className="host-protocol">SSH</span>
            <span>
              <strong>{host.name}</strong>
              <small>
                {host.username}@{hideAddresses ? maskHostAddress(host.hostname) : host.hostname}:
                {host.port}
              </small>
            </span>
            {host.favorite && <Pin size={12} fill="currentColor" />}
          </button>
        ))}
        {!recentHosts.length && (
          <button className="empty-bookmark-row" onClick={onOpenBookmarks}>
            <Server size={14} /> {x('shell.createFirstSshBookmark')}
          </button>
        )}
      </div>
    </MenuSurface>
  );
}

export function LayoutWorkspaceMenu({
  layout,
  workspaces,
  activeWorkspaceId,
  onLayout,
  onSave,
  onLoad,
  onDelete,
  onDismiss,
}: {
  layout: WorkspaceLayoutMode;
  workspaces: NamedWorkspace[];
  activeWorkspaceId: string | null;
  onLayout(value: WorkspaceLayoutMode): void;
  onSave(name: string): void;
  onLoad(workspace: NamedWorkspace): void;
  onDelete(workspace: NamedWorkspace): void;
  onDismiss(): void;
}) {
  const { language, t, x } = useI18n();
  const [tab, setTab] = useState<'layout' | 'workspace'>('layout');
  const [name, setName] = useState('');
  return (
    <MenuSurface className="layout-menu popover-surface" onDismiss={onDismiss}>
      <div className="menu-tabs">
        <button className={tab === 'layout' ? 'active' : ''} onClick={() => setTab('layout')}>
          <LayoutGrid size={13} /> {x('shell.layout')}
        </button>
        <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>
          <Save size={13} /> {x('shell.workspace')}
        </button>
      </div>
      {tab === 'layout' ? (
        <div className="layout-choice-grid">
          {layoutChoices.map((choice) => {
            const label = t(choice.labelKey);
            return (
              <button
                key={choice.id}
                data-layout-choice={choice.id}
                className={layout === choice.id ? 'active' : ''}
                title={label}
                onClick={() => {
                  onLayout(choice.id);
                  onDismiss();
                }}
              >
                <span className={`layout-glyph ${choice.className}`}>
                  {Array.from({ length: paneCount(choice.id) }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
                <small>{label}</small>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="workspace-menu">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              onSave(name.trim());
              setName('');
            }}
          >
            <input
              value={name}
              placeholder={x('shell.workspaceName')}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
            <button className="primary" type="submit" disabled={!name.trim()}>
              <Save size={13} /> {t('save', 'Save')}
            </button>
          </form>
          <div className="workspace-list-menu">
            {workspaces.map((workspace) => (
              <div
                className={activeWorkspaceId === workspace.id ? 'active' : ''}
                key={workspace.id}
              >
                <button onClick={() => onLoad(workspace)}>
                  <span>{workspace.name}</span>
                  <small>{new Date(workspace.updatedAt).toLocaleDateString(language)}</small>
                </button>
                <button
                  className="workspace-delete"
                  aria-label={x('shell.deleteWorkspace', { name: workspace.name })}
                  onClick={() => onDelete(workspace)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {!workspaces.length && <p>{x('shell.noSavedWorkspaces')}</p>}
          </div>
        </div>
      )}
    </MenuSurface>
  );
}

export function TerminalPaneGrid({
  client,
  layout,
  paneTerminalIds,
  focusedPane,
  tabs,
  profiles,
  connections,
  retryingConnectionIds,
  cancelingConnectionIds,
  onFocus,
  onSelect,
  onSwap,
  terminalSessionModes,
  onSetTerminalSessionMode,
  renderFileManager,
  onNewTerminal,
  onOpenBookmarks,
  onOpenAi,
  onOpenQuickConnect,
  activeTerminalId,
  renamingTabId,
  onActivate,
  onDuplicate,
  onFinishRename,
  onContextMenu,
  onMoveTab,
  onMoveTabToPane,
  onCloseTab,
  onOpenSessionMenu,
  onRetryConnection,
  onCancelConnectionReconnect,
  onReloadRdp,
  onReloadVnc,
  onReloadSpice,
  onReloadWeb,
  onTerminalViewChange,
  consumeTerminalReloadState,
  commandHistoryEnabled,
  screenReaderMode,
  commandSuggestionsEnabled,
  dragDropBehavior,
  themes,
  globalVisual,
  visualPreview,
  aiSuggestionsAvailable,
  onRequestAiSuggestions,
  onExplainSelection,
  onCommandHistoryChanged,
  onTransfersChanged,
  showTabNumber,
  switchTabOnHover,
  encodingOverrides,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  layout: WorkspaceLayoutMode;
  paneTerminalIds: Array<string | null>;
  focusedPane: number;
  tabs: TerminalTab[];
  profiles: TerminalProfile[];
  connections: Connection[];
  retryingConnectionIds: ReadonlySet<string>;
  cancelingConnectionIds: ReadonlySet<string>;
  onFocus(index: number): void;
  onSelect(index: number, id: string): void;
  onSwap(left: number, right: number): void;
  terminalSessionModes: Readonly<Record<string, TerminalSessionMode>>;
  onSetTerminalSessionMode(id: string, mode: TerminalSessionMode): void;
  renderFileManager(tab: TerminalTab, active: boolean): ReactNode;
  onNewTerminal(index: number): void;
  onOpenBookmarks(): void;
  onOpenAi(): void;
  onOpenQuickConnect(): void;
  activeTerminalId: string | undefined;
  renamingTabId: string | undefined;
  onActivate(id: string): void;
  onDuplicate(id: string): void;
  onFinishRename(id: string, title: string): void;
  onContextMenu(id: string, x: number, y: number): void;
  onMoveTab(id: string, targetId: string, after: boolean): void;
  onMoveTabToPane(id: string, index: number): void;
  onCloseTab(id: string): void;
  onOpenSessionMenu(index: number): void;
  onRetryConnection(tab: TerminalTab): void;
  onCancelConnectionReconnect(tab: TerminalTab): void;
  onReloadRdp(tab: TerminalTab): void;
  onReloadVnc(tab: TerminalTab): void;
  onReloadSpice(tab: TerminalTab): void;
  onReloadWeb(tab: TerminalTab): void;
  onTerminalViewChange(terminalId: string, view: TerminalViewHandle | null): void;
  consumeTerminalReloadState(terminalId: string): TerminalReloadState | undefined;
  commandHistoryEnabled: boolean;
  screenReaderMode: boolean;
  commandSuggestionsEnabled: boolean;
  dragDropBehavior: Settings['terminal']['dragDropBehavior'];
  themes: TerminalTheme[];
  globalVisual: TerminalVisualSettings | undefined;
  visualPreview: { terminalId: string; visual: TerminalVisualSettings } | undefined;
  aiSuggestionsAvailable: boolean;
  onRequestAiSuggestions(prefix: string, terminalId: string, signal: AbortSignal): Promise<string>;
  onExplainSelection(selection: string, terminalId: string): Promise<void>;
  onCommandHistoryChanged(): void;
  onTransfersChanged(): void;
  showTabNumber: boolean;
  switchTabOnHover: boolean;
  encodingOverrides: Readonly<Record<string, TerminalBehavior['encoding']>>;
}) {
  const { t, x } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const terminalViews = useRef(new Map<string, TerminalViewHandle>());
  const [ratios, setRatios] = useState(() => defaultPaneRatios(layout));
  const [maximized, setMaximized] = useState<{
    layout: WorkspaceLayoutMode;
    pane: number;
  }>();
  const maximizedPane = maximized?.layout === layout ? maximized.pane : undefined;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRatios(defaultPaneRatios(layout)));
    return () => window.cancelAnimationFrame(frame);
  }, [layout]);

  const resize = (
    event: ReactPointerEvent<HTMLDivElement>,
    axis: 'x' | 'y',
    key: 'x' | 'x2' | 'y' | 'y2',
  ) => {
    event.preventDefault();
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (pointer: PointerEvent) => {
      const raw =
        axis === 'x'
          ? ((pointer.clientX - bounds.left) / bounds.width) * 100
          : ((pointer.clientY - bounds.top) / bounds.height) * 100;
      setRatios((current) => {
        const lower = key === 'x2' ? current.x + 14 : key === 'y2' ? current.y + 14 : 16;
        const upper = key === 'x' ? current.x2 - 14 : key === 'y' ? current.y2 - 14 : 84;
        return { ...current, [key]: Math.max(lower, Math.min(upper, raw)) };
      });
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      document.body.classList.remove('resizing-panes');
    };
    document.body.classList.add('resizing-panes');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const style = {
    '--split-x': `${ratios.x}%`,
    '--split-x2': `${ratios.x2}%`,
    '--split-y': `${ratios.y}%`,
    '--split-y2': `${ratios.y2}%`,
  } as CSSProperties;

  return (
    <div
      ref={container}
      className={`terminal-pane-grid terminal-grid-${layout} ${maximizedPane === undefined ? '' : 'pane-maximized'}`}
      style={style}
    >
      {Array.from({ length: paneCount(layout) }, (_, index) => {
        const terminalId = paneTerminalIds[index];
        const tab = tabs.find((item) => item.id === terminalId);
        const connection = tab ? connectionForTerminal(tab, connections) : undefined;
        const supportsFileManager = tab?.kind === 'local' || tab?.kind === 'ssh';
        const sessionMode =
          supportsFileManager && terminalSessionModes[tab.id] === 'files' ? 'files' : 'terminal';
        const paneTabs = paneTabsInDisplayOrder(tabs, index);
        const tabbar = (
          <PaneTabBar
            index={index}
            tabs={paneTabs}
            activeTerminalId={terminalId ?? activeTerminalId}
            renamingTabId={renamingTabId}
            onFocus={onFocus}
            onActivate={onActivate}
            onDuplicate={onDuplicate}
            onFinishRename={onFinishRename}
            onContextMenu={onContextMenu}
            onMoveTab={onMoveTab}
            onMoveTabToPane={onMoveTabToPane}
            onCloseTab={onCloseTab}
            onNewTerminal={onNewTerminal}
            onOpenSessionMenu={onOpenSessionMenu}
            showTabNumber={showTabNumber}
            switchTabOnHover={switchTabOnHover}
          />
        );
        if (!tab) {
          return (
            <section
              key={index}
              className={
                focusedPane === index ? 'terminal-pane empty active' : 'terminal-pane empty'
              }
              hidden={maximizedPane !== undefined && maximizedPane !== index}
              style={maximizedPane === index ? { gridArea: '1 / 1 / -1 / -1' } : undefined}
              onMouseDown={() => onFocus(index)}
            >
              {tabbar}
              <div className="terminal-pane-body empty-pane-body">
                <EmptyPaneLanding
                  index={index}
                  tabs={tabs}
                  onSelect={onSelect}
                  onNewTerminal={onNewTerminal}
                  onOpenBookmarks={onOpenBookmarks}
                  onOpenAi={onOpenAi}
                  onOpenQuickConnect={onOpenQuickConnect}
                />
              </div>
            </section>
          );
        }
        return (
          <section
            key={index}
            className={focusedPane === index ? 'terminal-pane active' : 'terminal-pane'}
            hidden={maximizedPane !== undefined && maximizedPane !== index}
            style={maximizedPane === index ? { gridArea: '1 / 1 / -1 / -1' } : undefined}
            onMouseDown={() => onFocus(index)}
          >
            {tabbar}
            <header>
              <nav
                className="session-mode-tabs"
                role="tablist"
                aria-label={x('shell.sessionTools')}
              >
                <button
                  type="button"
                  role="tab"
                  id={`session-mode-terminal-${tab.id}`}
                  aria-controls={`session-terminal-panel-${tab.id}`}
                  className={sessionMode === 'terminal' ? 'active' : ''}
                  aria-selected={sessionMode === 'terminal'}
                  onClick={() => {
                    onFocus(index);
                    onSetTerminalSessionMode(tab.id, 'terminal');
                  }}
                >
                  {tab.kind === 'web'
                    ? x('shell.webPage')
                    : tab.kind === 'rdp' || tab.kind === 'vnc' || tab.kind === 'spice'
                      ? x('shell.remoteDesktop')
                      : tab.kind === 'ssh'
                        ? 'SSH'
                        : t('terminal', 'Terminal')}
                </button>
                {supportsFileManager && (
                  <button
                    type="button"
                    role="tab"
                    id={`session-mode-files-${tab.id}`}
                    aria-controls={`session-files-panel-${tab.id}`}
                    className={sessionMode === 'files' ? 'active' : ''}
                    aria-selected={sessionMode === 'files'}
                    onClick={() => {
                      onFocus(index);
                      onSetTerminalSessionMode(tab.id, 'files');
                    }}
                  >
                    {tab.kind === 'ssh' ? 'SFTP' : x('shell.fileManager')}
                  </button>
                )}
              </nav>
              <span
                className={tab?.disconnected ? 'session-state disconnected' : 'session-state'}
              />
              <select
                aria-label={x('shell.paneSession', { number: index + 1 })}
                value={terminalId ?? ''}
                onChange={(event) => onSelect(index, event.target.value)}
              >
                <option value="" disabled>
                  {x('shell.selectSession')}
                </option>
                {tabs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <div className="session-pane-actions">
                <button
                  aria-label={x('shell.searchPaneTerminal', { number: index + 1 })}
                  title={t('search', 'Search')}
                  disabled={
                    tab.disconnected ||
                    tab.kind === 'rdp' ||
                    tab.kind === 'vnc' ||
                    tab.kind === 'spice' ||
                    tab.kind === 'web'
                  }
                  onClick={() => {
                    onFocus(index);
                    onSetTerminalSessionMode(tab.id, 'terminal');
                    requestAnimationFrame(() => terminalViews.current.get(tab.id)?.openSearch());
                  }}
                >
                  <Search size={12} />
                </button>
                <button
                  aria-label={x(
                    maximizedPane === index ? 'shell.restorePane' : 'shell.maximizePane',
                    { number: index + 1 },
                  )}
                  title={x(maximizedPane === index ? 'shell.restorePane' : 'shell.maximizePane', {
                    number: index + 1,
                  })}
                  aria-pressed={maximizedPane === index}
                  onClick={() => {
                    onFocus(index);
                    onActivate(tab.id);
                    setMaximized((current) =>
                      current?.layout === layout && current.pane === index
                        ? undefined
                        : { layout, pane: index },
                    );
                  }}
                >
                  {maximizedPane === index ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
              </div>
              {index > 0 && (
                <button
                  title={x('shell.swapPreviousPane')}
                  aria-label={x('shell.swapPanes', { left: index, right: index + 1 })}
                  onClick={() => onSwap(index - 1, index)}
                >
                  <SplitSquareHorizontal size={12} />
                </button>
              )}
            </header>
            <div className="terminal-pane-body">
              {sessionMode === 'terminal' && tab.disconnected && (
                <div className="empty-pane">
                  <Terminal size={18} />
                  <span>{x('shell.sessionDisconnected')}</span>
                </div>
              )}
              {sessionMode === 'terminal' && tab.disconnected && connection && (
                <TerminalReconnectOverlay
                  connection={connection}
                  retrying={retryingConnectionIds.has(connection.id)}
                  canceling={cancelingConnectionIds.has(connection.id)}
                  onRetry={() => onRetryConnection(tab)}
                  onCancel={() => onCancelConnectionReconnect(tab)}
                />
              )}
            </div>
          </section>
        );
      })}
      <div
        className={`terminal-session-registry terminal-grid-${layout}`}
        aria-label={x('shell.terminalInstances')}
      >
        {tabs
          .filter((tab) => !tab.disconnected && paneOf(tab) < paneCount(layout))
          .map((tab) => {
            const paneIndex = paneOf(tab);
            const paneVisible =
              paneTerminalIds[paneIndex] === tab.id &&
              (maximizedPane === undefined || maximizedPane === paneIndex);
            const visible = paneVisible && terminalSessionModes[tab.id] !== 'files';
            const connection = connectionForTerminal(tab, connections);
            const visual =
              visualPreview?.terminalId === tab.id
                ? visualPreview.visual
                : (tab.visual ?? globalVisual);
            const theme = themes.find(({ id }) => id === visual?.themeId)?.terminal;
            return (
              <div
                key={tab.id}
                id={`session-terminal-panel-${tab.id}`}
                className="terminal-session-layer"
                data-terminal-session={tab.id}
                data-pane-index={paneIndex}
                role="tabpanel"
                aria-labelledby={`session-mode-terminal-${tab.id}`}
                hidden={!visible}
                aria-hidden={!visible}
                style={
                  maximizedPane === paneIndex
                    ? { gridArea: '1 / 1 / -1 / -1' }
                    : paneGridPlacement(layout, paneIndex)
                }
                onMouseDown={() => onFocus(paneIndex)}
              >
                {tab.kind === 'rdp' ? (
                  <RdpView
                    client={client}
                    sessionId={tab.id}
                    active={visible && focusedPane === paneIndex && activeTerminalId === tab.id}
                    onReload={() => onReloadRdp(tab)}
                  />
                ) : tab.kind === 'vnc' ? (
                  <VncView
                    client={client}
                    sessionId={tab.id}
                    active={visible && focusedPane === paneIndex && activeTerminalId === tab.id}
                    onReload={() => onReloadVnc(tab)}
                  />
                ) : tab.kind === 'spice' ? (
                  <SpiceView
                    client={client}
                    sessionId={tab.id}
                    active={visible && focusedPane === paneIndex && activeTerminalId === tab.id}
                    onReload={() => onReloadSpice(tab)}
                  />
                ) : tab.kind === 'web' ? (
                  <WebSessionView
                    client={client}
                    sessionId={tab.id}
                    active={visible && focusedPane === paneIndex && activeTerminalId === tab.id}
                    onReload={() => onReloadWeb(tab)}
                  />
                ) : (
                  <TerminalView
                    ref={(view) => {
                      if (view) terminalViews.current.set(tab.id, view);
                      else terminalViews.current.delete(tab.id);
                      onTerminalViewChange(tab.id, view);
                    }}
                    terminalId={tab.id}
                    client={client}
                    active={visible && focusedPane === paneIndex && activeTerminalId === tab.id}
                    kind={tab.kind}
                    shell={profiles.find((profile) => profile.id === tab.profileId)?.shell}
                    connectionId={connection?.state === 'ready' ? connection.id : undefined}
                    appearance={tab.appearance}
                    behavior={tab.behavior}
                    theme={theme}
                    background={visual?.background}
                    encodingOverride={encodingOverrides[tab.id]}
                    commandHistoryEnabled={commandHistoryEnabled}
                    screenReaderMode={screenReaderMode}
                    commandSuggestionsEnabled={commandSuggestionsEnabled}
                    dragDropBehavior={dragDropBehavior}
                    aiSuggestionsAvailable={aiSuggestionsAvailable}
                    onRequestAiSuggestions={onRequestAiSuggestions}
                    onExplainSelection={onExplainSelection}
                    onCommandHistoryChanged={onCommandHistoryChanged}
                    onTransfersChanged={onTransfersChanged}
                    consumeReloadState={consumeTerminalReloadState}
                  />
                )}
                {connection && (
                  <TerminalReconnectOverlay
                    connection={connection}
                    retrying={retryingConnectionIds.has(connection.id)}
                    canceling={cancelingConnectionIds.has(connection.id)}
                    onRetry={() => onRetryConnection(tab)}
                    onCancel={() => onCancelConnectionReconnect(tab)}
                  />
                )}
              </div>
            );
          })}
        {tabs
          .filter(
            (tab) =>
              (tab.kind === 'local' || tab.kind === 'ssh') && paneOf(tab) < paneCount(layout),
          )
          .map((tab) => {
            const paneIndex = paneOf(tab);
            const visible =
              terminalSessionModes[tab.id] === 'files' &&
              paneTerminalIds[paneIndex] === tab.id &&
              (maximizedPane === undefined || maximizedPane === paneIndex);
            return (
              <div
                key={`files:${tab.id}`}
                id={`session-files-panel-${tab.id}`}
                className="terminal-session-layer terminal-file-session-layer"
                data-file-session={tab.id}
                data-pane-index={paneIndex}
                role="tabpanel"
                aria-labelledby={`session-mode-files-${tab.id}`}
                hidden={!visible}
                aria-hidden={!visible}
                style={
                  maximizedPane === paneIndex
                    ? { gridArea: '1 / 1 / -1 / -1' }
                    : paneGridPlacement(layout, paneIndex)
                }
                onMouseDown={() => onFocus(paneIndex)}
              >
                {renderFileManager(tab, visible)}
              </div>
            );
          })}
      </div>
      {(layout === 'c2' ||
        layout === 'c3' ||
        layout === 'c2x2' ||
        layout === 'c1r2' ||
        layout === 'r1c2') && (
        <div
          className={`pane-resizer vertical ${layout === 'r1c2' ? 'partial-bottom' : ''}`}
          style={{ left: 'var(--split-x)' }}
          role="separator"
          aria-label={x('shell.resizeColumns')}
          aria-orientation="vertical"
          onPointerDown={(event) => resize(event, 'x', 'x')}
        />
      )}
      {layout === 'c3' && (
        <div
          className="pane-resizer vertical"
          style={{ left: 'var(--split-x2)' }}
          role="separator"
          aria-label={x('shell.resizeSecondColumn')}
          aria-orientation="vertical"
          onPointerDown={(event) => resize(event, 'x', 'x2')}
        />
      )}
      {(layout === 'r2' ||
        layout === 'r3' ||
        layout === 'c2x2' ||
        layout === 'c1r2' ||
        layout === 'r1c2') && (
        <div
          className={`pane-resizer horizontal ${layout === 'c1r2' ? 'partial-right' : ''}`}
          style={{ top: 'var(--split-y)' }}
          role="separator"
          aria-label={x('shell.resizeRows')}
          aria-orientation="horizontal"
          onPointerDown={(event) => resize(event, 'y', 'y')}
        />
      )}
      {layout === 'r3' && (
        <div
          className="pane-resizer horizontal"
          style={{ top: 'var(--split-y2)' }}
          role="separator"
          aria-label={x('shell.resizeSecondRow')}
          aria-orientation="horizontal"
          onPointerDown={(event) => resize(event, 'y', 'y2')}
        />
      )}
    </div>
  );
}

function connectionForTerminal(
  tab: TerminalTab,
  connections: Connection[],
): Connection | undefined {
  if (tab.kind !== 'ssh') return undefined;
  return (
    connections.find(
      (connection) =>
        connection.id === tab.connectionId &&
        connection.state !== 'closed' &&
        connection.state !== 'closing',
    ) ??
    connections.find(
      (connection) =>
        connection.hostId === tab.hostId &&
        connection.state !== 'closed' &&
        connection.state !== 'closing',
    )
  );
}

function PaneTabBar({
  index,
  tabs,
  activeTerminalId,
  renamingTabId,
  onFocus,
  onActivate,
  onDuplicate,
  onFinishRename,
  onContextMenu,
  onMoveTab,
  onMoveTabToPane,
  onCloseTab,
  onNewTerminal,
  onOpenSessionMenu,
  showTabNumber,
  switchTabOnHover,
}: {
  index: number;
  tabs: TerminalTab[];
  activeTerminalId: string | undefined;
  renamingTabId: string | undefined;
  onFocus(index: number): void;
  onActivate(id: string): void;
  onDuplicate(id: string): void;
  onFinishRename(id: string, title: string): void;
  onContextMenu(id: string, x: number, y: number): void;
  onMoveTab(id: string, targetId: string, after: boolean): void;
  onMoveTabToPane(id: string, index: number): void;
  onCloseTab(id: string): void;
  onNewTerminal(index: number): void;
  onOpenSessionMenu(index: number): void;
  showTabNumber: boolean;
  switchTabOnHover: boolean;
}) {
  const { x } = useI18n();
  const scroll = useRef<HTMLDivElement>(null);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [overflowMenuPosition, setOverflowMenuPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () => {
      const next = element.scrollWidth > element.clientWidth + 1;
      setOverflow(next);
      if (!next) setOverflowMenuOpen(false);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    for (const child of element.children) observer.observe(child);
    update();
    return () => observer.disconnect();
  }, [tabs]);

  const toggleOverflowMenu = () => {
    const bounds = overflowButton.current?.getBoundingClientRect();
    if (bounds)
      setOverflowMenuPosition({
        left: Math.max(4, Math.min(window.innerWidth - 224, bounds.right - 220)),
        top: Math.min(window.innerHeight - 40, bounds.bottom + 4),
      });
    setOverflowMenuOpen((open) => !open);
  };

  return (
    <div
      className="pane-tabbar"
      data-pane-index={index}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-axterm-tab')) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if ((event.target as HTMLElement).closest('.terminal-tab')) return;
        event.preventDefault();
        const id = event.dataTransfer.getData('application/x-axterm-tab');
        if (id) onMoveTabToPane(id, index);
      }}
    >
      <div
        ref={scroll}
        className="pane-tabbar-scroll"
        onWheel={(event) => {
          const element = scroll.current;
          if (!element || element.scrollWidth <= element.clientWidth) return;
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.preventDefault();
          element.scrollLeft += event.deltaY;
        }}
      >
        {tabs.map((tab) => (
          <div
            className={`workspace-tab terminal-tab ${activeTerminalId === tab.id ? 'active' : ''} ${tab.disconnected ? 'disconnected' : ''} ${tab.pinned ? 'pinned' : ''}`}
            key={tab.id}
            data-terminal-id={tab.id}
            role="tab"
            tabIndex={activeTerminalId === tab.id ? 0 : -1}
            draggable
            aria-selected={activeTerminalId === tab.id}
            onClick={() => onActivate(tab.id)}
            onMouseEnter={() => {
              if (
                switchTabOnHover &&
                activeTerminalId !== tab.id &&
                !document.querySelector('.terminal-tab.dragging')
              )
                onActivate(tab.id);
            }}
            onDoubleClick={() => onDuplicate(tab.id)}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onCloseTab(tab.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              onActivate(tab.id);
              onContextMenu(tab.id, event.clientX, event.clientY);
            }}
            onDragStart={(event) => {
              event.currentTarget.classList.add('dragging');
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-axterm-tab', tab.id);
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('application/x-axterm-tab')) return;
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              const after = event.clientX > bounds.left + bounds.width / 2;
              event.currentTarget.classList.toggle('drop-after', after);
              event.currentTarget.classList.toggle('drop-before', !after);
            }}
            onDragLeave={(event) => {
              event.currentTarget.classList.remove('drop-before', 'drop-after');
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const bounds = event.currentTarget.getBoundingClientRect();
              onMoveTab(
                event.dataTransfer.getData('application/x-axterm-tab'),
                tab.id,
                event.clientX > bounds.left + bounds.width / 2,
              );
              event.currentTarget.classList.remove('drop-before', 'drop-after');
            }}
            onDragEnd={() => {
              document
                .querySelectorAll('.terminal-tab.dragging')
                .forEach((element) => element.classList.remove('dragging'));
              document
                .querySelectorAll('.terminal-tab.drop-before, .terminal-tab.drop-after')
                .forEach((element) => element.classList.remove('drop-before', 'drop-after'));
            }}
            onKeyDown={(event) => {
              handleTerminalTabKey(event, tab, tabs, onActivate, onMoveTab);
            }}
          >
            <GripVertical className="tab-grip" size={12} />
            <span className="tab-state" />
            {showTabNumber && <span className="tab-number">{tab.tabNumber}</span>}
            <Terminal size={14} />
            {tab.pinned && <Pin className="tab-pin" size={10} fill="currentColor" />}
            {renamingTabId === tab.id ? (
              <input
                className="tab-rename"
                autoFocus
                defaultValue={tab.title}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => onFinishRename(tab.id, event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') onFinishRename(tab.id, tab.title);
                }}
              />
            ) : (
              <span className="tab-title">{tab.title}</span>
            )}
            <button
              className="tab-close"
              aria-label={x('shell.closeTab', { title: tab.title })}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="tab-add"
          onClick={() => {
            onFocus(index);
            onNewTerminal(index);
          }}
          title={x('shell.newLocalTerminalInPane', { number: index + 1 })}
        >
          <Plus size={15} />
        </button>
        <button
          className="tab-add-menu"
          onClick={() => {
            onFocus(index);
            onOpenSessionMenu(index);
          }}
          title={x('shell.newSessionMenuInPane', { number: index + 1 })}
        >
          <ChevronDown size={11} />
        </button>
        <div className="pane-tabbar-drag-space" aria-hidden="true" />
      </div>
      {overflow && (
        <div className="pane-tabbar-overflow" data-testid={`pane-${index + 1}-tab-overflow`}>
          <button
            title={x('shell.scrollTabsLeft', { number: index + 1 })}
            aria-label={x('shell.scrollTabsLeft', { number: index + 1 })}
            onClick={() => scroll.current?.scrollBy({ left: -180, behavior: 'smooth' })}
          >
            <ChevronLeft size={12} />
          </button>
          <button
            title={x('shell.scrollTabsRight', { number: index + 1 })}
            aria-label={x('shell.scrollTabsRight', { number: index + 1 })}
            onClick={() => scroll.current?.scrollBy({ left: 180, behavior: 'smooth' })}
          >
            <ChevronRight size={12} />
          </button>
          <button
            ref={overflowButton}
            className={overflowMenuOpen ? 'active' : ''}
            title={x('shell.allPaneTabs', { number: index + 1 })}
            aria-label={x('shell.allPaneTabs', { number: index + 1 })}
            onClick={toggleOverflowMenu}
          >
            <ChevronDown size={12} />
          </button>
        </div>
      )}
      {overflowMenuOpen &&
        createPortal(
          <TabOverflowMenu
            tabs={tabs}
            activeTerminalId={activeTerminalId}
            onSelect={(id) => {
              onFocus(index);
              onActivate(id);
            }}
            onDismiss={() => setOverflowMenuOpen(false)}
            style={{
              position: 'fixed',
              left: overflowMenuPosition.left,
              top: overflowMenuPosition.top,
              right: 'auto',
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function EmptyPaneLanding({
  index,
  tabs,
  onSelect,
  onNewTerminal,
  onOpenBookmarks,
  onOpenAi,
  onOpenQuickConnect,
}: {
  index: number;
  tabs: TerminalTab[];
  onSelect(index: number, id: string): void;
  onNewTerminal(index: number): void;
  onOpenBookmarks(): void;
  onOpenAi(): void;
  onOpenQuickConnect(): void;
}) {
  const { t, x } = useI18n();
  return (
    <div className="empty-pane-landing" data-testid={`empty-pane-${index + 1}`}>
      <div className="empty-pane-actions">
        <button className="empty-pane-new-terminal" onClick={() => onNewTerminal(index)}>
          {t('newTerminal', 'New tab')}
        </button>
        <button onClick={onOpenBookmarks}>{t('newBookmark', 'New bookmark')}</button>
        <button onClick={onOpenAi}>
          <Bot size={13} /> {t('createBookmarkByAI', 'Create bookmark by AI')}
        </button>
        <button onClick={onOpenQuickConnect}>
          <Zap size={13} /> {t('quickConnect', 'Quick connect')} <CircleHelp size={12} />
        </button>
      </div>
      <div className="empty-pane-brand" aria-hidden="true">
        <b className="empty-pane-shape">
          <strong>Axterm</strong>
        </b>
        <span>AX</span>
        <small>1.0</small>
      </div>
      <footer>
        <span className="empty-pane-sort">
          <i /> {t('sortByFrequency', 'Sort by frequency')}
        </span>
        {!!tabs.length && (
          <label
            className="empty-pane-session"
            title={x('shell.selectExistingSessionForPane', { number: index + 1 })}
          >
            <List size={13} />
            <select
              aria-label={x('shell.selectExistingSessionForPane', { number: index + 1 })}
              value=""
              onChange={(event) => onSelect(index, event.target.value)}
            >
              <option value="" disabled>
                {x('shell.selectExistingSession')}
              </option>
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </footer>
    </div>
  );
}

function paneGridPlacement(layout: WorkspaceLayoutMode, paneIndex: number): CSSProperties {
  if (layout === 'c1r2')
    return { gridArea: (['primary', 'secondary', 'tertiary'] as const)[paneIndex] };
  if (layout === 'r1c2')
    return { gridArea: (['primary', 'secondary', 'tertiary'] as const)[paneIndex] };
  if (layout === 'c2x2')
    return {
      gridRow: Math.floor(paneIndex / 2) + 1,
      gridColumn: (paneIndex % 2) + 1,
    };
  if (layout === 'r2' || layout === 'r3') return { gridRow: paneIndex + 1, gridColumn: 1 };
  return { gridRow: 1, gridColumn: paneIndex + 1 };
}

function defaultPaneRatios(layout: WorkspaceLayoutMode) {
  return {
    x: layout === 'c3' ? 33.33 : 50,
    x2: 66.67,
    y: layout === 'r3' ? 33.33 : 50,
    y2: 66.67,
  };
}

export function NoSessionView({
  onLocal,
  onOpenBookmarks,
  onOpenAi,
  onQuickConnect,
  historyPanel,
}: {
  onLocal(): void;
  onOpenBookmarks(): void;
  onOpenAi(): void;
  onQuickConnect(target: QuickConnectTarget): void;
  historyPanel: ReactNode;
}) {
  const { t, x } = useI18n();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const submit = () => {
    const target = parseQuickConnect(value);
    if (!target) {
      setError(x('shell.quickConnectFormat'));
      return;
    }
    onQuickConnect(target);
  };
  return (
    <div className="no-session-view">
      <div className="no-session-actions empty-pane-actions">
        <button className="primary" onClick={onLocal}>
          {t('newTerminal', 'New tab')}
        </button>
        <button onClick={onOpenBookmarks}>{t('newBookmark', 'New bookmark')}</button>
        <button onClick={onOpenAi}>
          <Bot size={13} /> {t('createBookmarkByAI', 'Create bookmark by AI')}
        </button>
        <button onClick={() => setQuickConnectOpen((open) => !open)}>
          <Zap size={13} /> {t('quickConnect', 'Quick connect')} <CircleHelp size={12} />
        </button>
      </div>
      {quickConnectOpen && (
        <div className="no-session-quick">
          <label htmlFor="empty-quick-connect">Quick Connect</label>
          <div>
            <Zap size={14} />
            <input
              id="empty-quick-connect"
              value={value}
              placeholder="ssh://user@example.com:22"
              autoFocus
              onChange={(event) => {
                setValue(event.target.value);
                setError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
            <button onClick={submit}>
              {t('connect', 'Connect')} <ArrowRight size={13} />
            </button>
          </div>
          {error && <small>{error}</small>}
        </div>
      )}
      <div className="no-session-brand empty-pane-brand" aria-hidden="true">
        <b className="empty-pane-shape">
          <strong>Axterm</strong>
        </b>
        <span>AX</span>
        <small>1.0</small>
      </div>
      <div className="no-session-history">{historyPanel}</div>
    </div>
  );
}

export function TabOverflowMenu({
  tabs,
  activeTerminalId,
  onSelect,
  onDismiss,
  style,
}: {
  tabs: TerminalTab[];
  activeTerminalId: string | undefined;
  onSelect(id: string): void;
  onDismiss(): void;
  style?: CSSProperties | undefined;
}) {
  const { x } = useI18n();
  return (
    <MenuSurface className="tab-overflow-menu popover-surface" style={style} onDismiss={onDismiss}>
      <header>
        <strong>{x('shell.allTabs')}</strong>
        <small>{tabs.length}</small>
      </header>
      <div>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={tab.id === activeTerminalId ? 'active' : ''}
            onClick={() => {
              onSelect(tab.id);
              onDismiss();
            }}
          >
            <span className={tab.disconnected ? 'session-state disconnected' : 'session-state'} />
            <Terminal size={13} />
            <span>{tab.title}</span>
            {tab.pinned && <Pin size={10} fill="currentColor" />}
          </button>
        ))}
      </div>
    </MenuSurface>
  );
}

export function WindowControls({
  client,
  openTabCount,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  openTabCount: number;
}) {
  const { x } = useI18n();
  const [maximized, setMaximized] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const [closeError, setCloseError] = useState('');
  const [closing, setClosing] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void client
        .windowStatus()
        .then((state) => {
          if (!disposed) {
            setMaximized(state.maximized);
            setFullScreen(state.fullScreen);
          }
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('resize', refresh);
    return () => {
      disposed = true;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('resize', refresh);
    };
  }, [client]);

  const perform = async (
    action: 'minimize' | 'toggle-maximize' | 'toggle-fullscreen' | 'close',
  ) => {
    try {
      const result = await client.performWindowAction(action);
      setMaximized(result.state.maximized);
      setFullScreen(result.state.fullScreen);
    } catch {
      // The close action can destroy the document before its response arrives.
    }
  };

  const dismissCloseConfirmation = () => {
    setConfirmCloseOpen(false);
    setCloseError('');
    closeButton.current?.focus();
  };

  const closeWindow = async () => {
    if (closing) return;
    setClosing(true);
    setCloseError('');
    try {
      await client.performWindowAction('close');
    } catch {
      // A successful close can destroy the document before the response arrives.
      if (document.visibilityState === 'visible') setCloseError(x('shell.closeWindowFailed'));
    } finally {
      setClosing(false);
    }
  };

  const requestClose = () => {
    if (closing || confirmCloseOpen) return;
    setCloseError('');
    if (openTabCount > 1) setConfirmCloseOpen(true);
    else void closeWindow();
  };

  return (
    <div className="window-controls" aria-label={x('shell.windowControls')}>
      <button
        data-window-action="toggle-fullscreen"
        title={fullScreen ? x('shell.exitFullscreen') : x('shell.fullscreen')}
        aria-label={fullScreen ? x('shell.exitFullscreen') : x('shell.fullscreen')}
        onClick={() => void perform('toggle-fullscreen')}
      >
        <Scan size={13} />
      </button>
      {!isMac && (
        <>
          <button
            data-window-action="minimize"
            title={x('shell.minimize')}
            aria-label={x('shell.minimize')}
            onClick={() => void perform('minimize')}
          >
            <Minus size={13} />
          </button>
          <button
            data-window-action="toggle-maximize"
            title={maximized ? x('shell.restore') : x('shell.maximize')}
            aria-label={maximized ? x('shell.restore') : x('shell.maximize')}
            onClick={() => void perform('toggle-maximize')}
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            ref={closeButton}
            className="window-control-close"
            data-window-action="close"
            title={x('shell.closeWindow')}
            aria-label={x('shell.closeWindow')}
            onClick={requestClose}
          >
            <X size={14} />
          </button>
        </>
      )}
      {closeError && !confirmCloseOpen && (
        <span className="window-close-error" role="alert">
          {closeError}
        </span>
      )}
      {confirmCloseOpen &&
        createPortal(
          <div className="modal-backdrop">
            <section
              className="modal window-close-confirmation"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="window-close-confirmation-title"
              aria-describedby="window-close-confirmation-description"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !closing) dismissCloseConfirmation();
              }}
            >
              <header>
                <h2 id="window-close-confirmation-title">
                  {x('shell.confirmCloseTabsTitle', { count: openTabCount })}
                </h2>
              </header>
              <div className="window-close-confirmation-body">
                <p id="window-close-confirmation-description">
                  {x('shell.confirmCloseTabsDescription')}
                </p>
                {closeError && <p role="alert">{closeError}</p>}
                <div className="modal-actions">
                  <button autoFocus disabled={closing} onClick={dismissCloseConfirmation}>
                    {x('common.cancel')}
                  </button>
                  <button className="danger" disabled={closing} onClick={() => void closeWindow()}>
                    {x('shell.closeWindow')}
                  </button>
                </div>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
