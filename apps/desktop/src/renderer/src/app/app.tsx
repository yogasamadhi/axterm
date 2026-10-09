import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Tooltip } from '@base-ui/react/tooltip';
import type { createRuntimeClient } from '@workspace/client';
import type {
  Bookmark,
  BookmarkDropPosition,
  BookmarkTreeNodeRef,
  BookmarkTree as BookmarkTreeValue,
  Connection,
  ConnectionHistoryItem,
  Host,
  RemoteMonitorItem,
  Settings as RuntimeSettings,
  ShortcutActionId,
  TerminalBehavior,
  TerminalShortcutButton,
} from '@workspace/contracts';
import {
  connectionSchema,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_INFORMATION_ITEMS,
  DEFAULT_TERMINAL_SHORTCUT_BUTTONS,
  TERMINAL_ENCODINGS,
} from '@workspace/contracts';
import { desktopLifecycleStateSchema, type FileGrant } from '@workspace/contracts/desktop';
import { parseQuickConnect, type QuickConnectTarget } from '@workspace/shared';
import {
  Activity,
  ArrowDownToLine,
  BookOpen,
  BookmarkPlus,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command,
  Ellipsis,
  Folder,
  GripVertical,
  Info,
  LayoutGrid,
  Network,
  PanelRightClose,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { TerminalReconnectTransitionTracker } from '../components/terminal-reconnect';
import {
  TerminalReloadStateRegistry,
  type TerminalReloadState,
} from '../components/terminal-reload-state';
import { TerminalShortcutBar } from '../components/terminal-shortcut-bar';
import type { TerminalViewHandle } from '../components/terminal-view';
import { useI18n } from '../i18n/context';
import type { AxtermMessageKey } from '../i18n/core';
import {
  paneCount,
  paneOf,
  paneTabsInDisplayOrder,
  shouldActivateStartupSurface,
  useWorkspace,
  type TerminalTab,
  type WorkspaceSection,
} from '../stores/workspace';
import { orderedActivityRailItems, type VisibleActivityRailItem } from './activity-rail';
import { AiPanel } from './ai/ai-panel';
import { updateCachedSettings } from './settings-cache';
import { useTerminalAiActions, type TerminalAiDraft } from './ai/use-terminal-ai-actions';
import { BatchInput } from './batch-input/batch-input';
import { BookmarkGroupDialog } from './bookmarks/bookmark-group-dialog';
import { BookmarkTree as BookmarkTreePanel } from './bookmarks/bookmark-tree-panel';
import { CommandHistoryPopover } from './command-history/command-history-popover';
import { parseCommandLineBatchOperation } from './command-line-batch-operation';
import { CommandPalette } from './command-palette/command-palette';
import {
  shortcutUnavailableReason,
  type PaletteItem,
  type ShortcutContext,
} from './command-palette/palette-model';
import { useCommandPalette } from './command-palette/use-command-palette';
import { waitForConnectionReady } from './connections/wait-for-connection';
import { FilesPanel } from './files/files-panel';
import { ConnectionHistorySidebar } from './history/history-sidebar';
import {
  CommandsPanel,
  HostsPanel,
  InteractionOverlay,
  RuntimePanel,
  TunnelsPanel,
} from './panels';
import { proxyCredentialRefs } from './proxy-settings-model';
import { QuickCommandPopover } from './quick-commands/quick-command-popover';
import { RemoteMonitorBar } from './remote-monitor/remote-monitor-bar';
import {
  LayoutWorkspaceMenu,
  NewSessionMenu,
  NoSessionView,
  TabOverflowMenu,
  TerminalPaneGrid,
  WindowControls,
  type NamedWorkspace,
} from './shell-controls';
import { LocalShellError, shellErrorMessage } from './shell-error';
import {
  isShortcutInputTarget,
  shortcutActionForChord,
  shortcutFromKeyboardEvent,
  shortcutFromWheelEvent,
  shortcutPlatform,
} from './shortcuts/shortcut-registry';
import { SshConfigImportDialog } from './ssh-config-import/ssh-config-import-dialog';
import { TerminalInformationPanel } from './terminal-information/terminal-information-panel';
import { resolveTerminalProfileId } from './terminal-profile-selection';
import { TransferCenter } from './transfers/transfer-center';

const statusKey = ['runtime', 'status'] as const;
type RecoveryNoticeKind = 'offline' | 'recovered' | 'resumed' | 'runtime-restarted';
interface RecoveryNotice {
  kind: RecoveryNoticeKind;
  nonce: number;
}
const navigation: Array<{
  id: WorkspaceSection;
  messageKey: AxtermMessageKey;
  icon: typeof Server;
}> = [
  { id: 'hosts', messageKey: 'app.hosts', icon: Server },
  { id: 'files', messageKey: 'app.fileTransfer', icon: Folder },
  { id: 'tunnels', messageKey: 'app.tunnels', icon: Network },
  { id: 'commands', messageKey: 'app.quickCommands', icon: Command },
  { id: 'ai', messageKey: 'app.aiAssistant', icon: Bot },
  { id: 'settings', messageKey: 'app.settingsDiagnostics', icon: Settings },
];

const activityRailDefinitions: Record<
  VisibleActivityRailItem,
  { translationKey: string; fallback: string; icon: typeof Server }
> = {
  newBookmark: {
    translationKey: 'newBookmark',
    fallback: 'Add saved connection',
    icon: BookmarkPlus,
  },
  bookmarks: { translationKey: 'bookmarks', fallback: 'Bookmarks', icon: BookOpen },
  setting: { translationKey: 'setting', fallback: 'Settings', icon: Settings },
};

export function App({ client }: { client: ReturnType<typeof createRuntimeClient> }) {
  const { t, x } = useI18n();
  const xRef = useRef(x);
  useLayoutEffect(() => {
    xRef.current = x;
  }, [x]);
  const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const isWindows = /Windows/.test(navigator.userAgent);
  const platform = shortcutPlatform(navigator.userAgent);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) => client.status(signal),
    retry: false,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });
  const ready = status.isSuccess;
  const hosts = useQuery({
    queryKey: ['hosts'],
    queryFn: client.hosts,
    enabled: ready,
  });
  const bookmarkTree = useQuery({
    queryKey: ['bookmark-tree'],
    queryFn: client.bookmarkTree,
    enabled: ready,
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: client.connections,
    enabled: ready,
    refetchInterval: 1_000,
  });
  const ftpConnections = useQuery({
    queryKey: ['ftp-connections'],
    queryFn: client.ftpConnections,
    enabled: ready,
    refetchInterval: 1_000,
  });
  const transfers = useQuery({
    queryKey: ['transfers'],
    queryFn: client.transfers,
    enabled: ready,
    retry: false,
    refetchInterval: 1_000,
  });
  const aiModels = useQuery({
    queryKey: ['ai-models'],
    queryFn: client.aiModels,
    enabled: ready,
    staleTime: 30_000,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: client.settings,
    enabled: ready,
  });
  const terminalProfiles = useQuery({
    queryKey: ['terminal-profiles'],
    queryFn: client.terminalProfiles,
    enabled: ready,
  });
  const terminalThemes = useQuery({
    queryKey: ['terminal-themes'],
    queryFn: client.terminalThemes,
    enabled: ready,
  });
  const section = useWorkspace((state) => state.section);
  const contentSurface = useWorkspace((state) => state.contentSurface);
  const setSection = useWorkspace((state) => state.setSection);
  const showSection = useWorkspace((state) => state.showSection);
  const setActiveFtpConnection = useWorkspace((state) => state.setActiveFtpConnection);
  const sidebarOpen = useWorkspace((state) => state.sidebarOpen);
  const toggleSidebar = useWorkspace((state) => state.toggleSidebar);
  const aiInspectorOpen = useWorkspace((state) => state.aiInspectorOpen);
  const toggleAiInspector = useWorkspace((state) => state.toggleAiInspector);
  const setAiInspector = useWorkspace((state) => state.setAiInspector);
  const paletteOpen = useWorkspace((state) => state.paletteOpen);
  const setPalette = useWorkspace((state) => state.setPalette);
  const tabs = useWorkspace((state) => state.tabs);
  const terminalVisualPreview = useWorkspace((state) => state.terminalVisualPreview);
  const activeTerminalId = useWorkspace((state) => state.activeTerminalId);
  const secondaryTerminalId = useWorkspace((state) => state.secondaryTerminalId);
  const split = useWorkspace((state) => state.split);
  const layoutMode = useWorkspace((state) => state.layoutMode);
  const paneTerminalIds = useWorkspace((state) => state.paneTerminalIds);
  const focusedPane = useWorkspace((state) => state.focusedPane);
  const terminalSessionModes = useWorkspace((state) => state.terminalSessionModes);
  const addTerminal = useWorkspace((state) => state.addTerminal);
  const insertTerminalAfter = useWorkspace((state) => state.insertTerminalAfter);
  const replaceTerminal = useWorkspace((state) => state.replaceTerminal);
  const closeTerminal = useWorkspace((state) => state.closeTerminal);
  const renameTerminal = useWorkspace((state) => state.renameTerminal);
  const moveTerminal = useWorkspace((state) => state.moveTerminal);
  const moveTerminalToPane = useWorkspace((state) => state.moveTerminalToPane);
  const pinTerminal = useWorkspace((state) => state.pinTerminal);
  const setActiveTerminal = useWorkspace((state) => state.setActiveTerminal);
  const setLayoutMode = useWorkspace((state) => state.setLayoutMode);
  const setPaneTerminal = useWorkspace((state) => state.setPaneTerminal);
  const focusPane = useWorkspace((state) => state.focusPane);
  const setTerminalSessionMode = useWorkspace((state) => state.setTerminalSessionMode);
  const swapPanes = useWorkspace((state) => state.swapPanes);
  const detailsOpen = useWorkspace((state) => state.detailsOpen);
  const toggleDetails = useWorkspace((state) => state.toggleDetails);
  const clearForGeneration = useWorkspace((state) => state.clearForGeneration);
  const restoreLayout = useWorkspace((state) => state.restoreLayout);
  const persistedLayoutWritePolicy = useWorkspace((state) => state.persistedLayoutWritePolicy);
  const generation = useRef<string | undefined>(undefined);
  const reconnectTransitions = useRef(new TerminalReconnectTransitionTracker(64));
  const pendingRecoveredConnections = useRef(new Set<string>());
  const activeConnectionReloads = useRef(new Set<string>());
  const retryingConnectionIdsRef = useRef(new Set<string>());
  const cancelingConnectionIdsRef = useRef(new Set<string>());
  const terminalViews = useRef(new Map<string, TerminalViewHandle>());
  const terminalReloadStates = useRef(new TerminalReloadStateRegistry());
  const appDisposed = useRef(false);
  const connectionWaits = useRef(new Set<AbortController>());
  const restoringAfterRuntimeRestart = useRef(
    new URLSearchParams(window.location.search).get('recovery') === 'runtime-restarted',
  );
  const startupTerminalRequested = useRef(false);
  const startupBookmarkConnector = useRef<(bookmark: Bookmark, backgroundStartup: boolean) => void>(
    () => {},
  );
  const startupWorkspaceLoader = useRef<(workspace: NamedWorkspace) => Promise<void>>(
    async () => {},
  );
  const tabbar = useRef<HTMLDivElement>(null);
  const windowControlBar = useRef<HTMLDivElement>(null);
  const workspaceMain = useRef<HTMLElement>(null);
  const shellRoot = useRef<HTMLDivElement>(null);
  const activityRail = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!isMac || !shellRoot.current) return;
    const shell = shellRoot.current;
    let pendingFrame: number | undefined;
    const measure = () => {
      // Native window buttons do not zoom with the document. Reserve their
      // physical area in CSS pixels using the unzoomed window width.
      const zoom =
        window.outerWidth > 0 && window.innerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
      shell.style.setProperty('--shell-native-controls-width', `${80 / zoom}px`);
      shell.style.setProperty('--shell-native-controls-height', `${38 / zoom}px`);
    };
    const update = () => {
      measure();
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      // Native outerWidth can settle after Chromium's resize/zoom event,
      // especially during a packaged macOS window resize. Reconcile for a
      // bounded half-second at 60 Hz, retaining deterministic cancellation.
      let remainingFrames = 30;
      const reconcile = () => {
        pendingFrame = undefined;
        measure();
        if (--remainingFrames > 0) pendingFrame = requestAnimationFrame(reconcile);
      };
      pendingFrame = requestAnimationFrame(reconcile);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      shell.style.removeProperty('--shell-native-controls-width');
      shell.style.removeProperty('--shell-native-controls-height');
    };
  }, [isMac]);
  const [terminalError, setTerminalError] = useState('');
  const [terminalAiDraft, setTerminalAiDraft] = useState<TerminalAiDraft>();
  const [recoveryNotice, setRecoveryNotice] = useState<RecoveryNotice | undefined>(() =>
    new URLSearchParams(window.location.search).get('recovery') === 'runtime-restarted'
      ? { kind: 'runtime-restarted', nonce: Date.now() }
      : undefined,
  );
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [bookmarkGroupDialog, setBookmarkGroupDialog] = useState<
    | { kind: 'create'; parentId: string | null }
    | {
        kind: 'rename';
        id: string;
        initialValue: { name: string; color: string | null; description: string };
      }
  >();
  const [bookmarkEditId, setBookmarkEditId] = useState<string>();
  const [bookmarkCreateRequested, setBookmarkCreateRequested] = useState(false);
  const [hostManagerContainer, setHostManagerContainer] = useState<HTMLDivElement | null>(null);
  const [requestedQuickConnect, setRequestedQuickConnect] = useState<QuickConnectTarget>();
  const [settingsDestination, setSettingsDestination] = useState<{
    tab: 'setting' | 'themes' | 'profiles' | 'widgets';
    item: 'terminal' | 'common' | 'sync';
    nonce: number;
  }>({ tab: 'setting', item: 'terminal', nonce: 0 });
  const [bookmarkManagerOpen, setBookmarkManagerOpen] = useState(false);
  const [hostSidebarTab, setHostSidebarTab] = useState<'bookmarks' | 'history'>('bookmarks');
  const [commandWorkspaceSection, setCommandWorkspaceSection] = useState<
    'quick-commands' | 'batch-operations' | 'triggers'
  >('quick-commands');
  const [deepLinkInitialCheckCompleted, setDeepLinkInitialCheckCompleted] = useState(false);
  const deepLinkDrainActive = useRef(false);
  const deepLinkDrainRequested = useRef(false);
  const deepLinkDrain = useRef<() => Promise<void>>(async () => undefined);
  const [sshConfigImportGrant, setSshConfigImportGrant] = useState<FileGrant>();
  const [transferCenterOpen, setTransferCenterOpen] = useState(false);
  const [initialFileDirectoryGrantId, setInitialFileDirectoryGrantId] = useState<string>();
  const [requestedSftpDirectory, setRequestedSftpDirectory] = useState<{
    connectionId: string;
    path: string;
    nonce: string;
  }>();
  const [terminalInformationOpen, setTerminalInformationOpen] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string>();
  const [hoveredWorkspaceTabId, setHoveredWorkspaceTabId] = useState<string>();
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number }>();
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [tabOverflow, setTabOverflow] = useState(false);
  const [tabOverflowMenuOpen, setTabOverflowMenuOpen] = useState(false);
  const [terminalEncodingOverrides, setTerminalEncodingOverrides] = useState<
    Record<string, TerminalBehavior['encoding']>
  >({});
  const [retryingConnectionIds, setRetryingConnectionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [cancelingConnectionIds, setCancelingConnectionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [paletteContext, setPaletteContext] = useState<{
    terminalId: string | undefined;
    value: ShortcutContext;
  }>({
    terminalId: undefined,
    value: {
      runtimeReady: false,
      tabCount: 0,
      hasTerminalView: false,
      terminalConnected: false,
      hasSelection: false,
      sshConnected: false,
      hasSftpPath: false,
    },
  });

  function shortcutContext() {
    const workspace = useWorkspace.getState();
    const active = workspace.tabs.find(({ id }) => id === workspace.activeTerminalId);
    const view = active ? terminalViews.current.get(active.id) : undefined;
    return {
      runtimeReady: ready,
      activeTabKind: active?.kind,
      tabCount: workspace.tabs.length,
      hasTerminalView: !!view,
      terminalConnected: !!active && !active.disconnected,
      hasSelection: view?.hasSelection() ?? false,
      sshConnected:
        active?.kind === 'ssh' &&
        !!connections.data?.some(
          ({ id, state }) => id === active.connectionId && state === 'ready',
        ),
      hasSftpPath: !!view?.getCwd().startsWith('/'),
    };
  }
  const paletteActiveTab = tabs.find(({ id }) => id === activeTerminalId);
  const paletteTargetUnchanged = paletteContext.terminalId === activeTerminalId;
  const palette = useCommandPalette({
    x,
    platform,
    bindings: settings.data?.shortcuts.bindings,
    context: {
      ...paletteContext.value,
      runtimeReady: ready,
      activeTabKind: paletteActiveTab?.kind,
      tabCount: tabs.length,
      terminalConnected: !!paletteActiveTab && !paletteActiveTab.disconnected,
      sshConnected:
        paletteActiveTab?.kind === 'ssh' &&
        !!connections.data?.some(
          ({ id, state }) => id === paletteActiveTab.connectionId && state === 'ready',
        ),
      hasTerminalView: paletteTargetUnchanged && paletteContext.value.hasTerminalView,
      hasSelection: paletteTargetUnchanged && paletteContext.value.hasSelection,
      hasSftpPath: paletteTargetUnchanged && paletteContext.value.hasSftpPath,
    },
    sections: navigation,
    hosts: hosts.data ?? [],
    sessions: tabs,
    workspaces: settings.data?.workspace.namedWorkspaces ?? [],
  });

  function openBookmarkManager() {
    setBookmarkManagerOpen(true);
    setHostSidebarTab('bookmarks');
    showSection('hosts');
  }

  function openNewBookmark() {
    setBookmarkEditId(undefined);
    setBookmarkCreateRequested(true);
  }

  function executePaletteItem(item: PaletteItem): boolean {
    const intent = item.intent;
    if (intent.kind === 'shortcut') {
      if (!runShortcutAction(intent.action)) return false;
    } else if (intent.kind === 'section') {
      if (intent.section === 'files') {
        if (!ready) return false;
        void openFilesInSession();
      } else showSection(intent.section);
    } else if (intent.kind === 'transfer-center') {
      setTransferCenterOpen(true);
    } else if (intent.kind === 'host') {
      const host = (queryClient.getQueryData<Host[]>(['hosts']) ?? hosts.data)?.find(
        ({ id }) => id === intent.id,
      );
      if (!ready || !host) return false;
      void openHostTerminal(host);
    } else if (intent.kind === 'session') {
      const tab = useWorkspace.getState().tabs.find(({ id }) => id === intent.id);
      if (!tab) return false;
      setTerminalSessionMode(tab.id, 'terminal');
    } else {
      const workspace = (
        queryClient.getQueryData<RuntimeSettings>(['settings']) ?? settings.data
      )?.workspace.namedWorkspaces.find(({ id }) => id === intent.id);
      if (!ready || !workspace) return false;
      void loadWorkspace(workspace);
    }
    palette.remember(item.id);
    return true;
  }

  const registerTerminalView = useCallback(
    (terminalId: string, view: TerminalViewHandle | null) => {
      if (view) terminalViews.current.set(terminalId, view);
      else terminalViews.current.delete(terminalId);
    },
    [],
  );

  const consumeTerminalReloadState = useCallback(
    (terminalId: string): TerminalReloadState | undefined =>
      terminalReloadStates.current.consume(terminalId),
    [],
  );

  const captureTerminalReloadState = useCallback(
    (tab: TerminalTab): TerminalReloadState | undefined => {
      if (tab.kind !== 'ssh' || !settings.data?.terminal.restoreTerminalSessionOnReload)
        return undefined;
      return terminalViews.current.get(tab.id)?.captureReloadState();
    },
    [settings.data?.terminal.restoreTerminalSessionOnReload],
  );

  const updateTerminalShortcutButtons = useCallback(
    async (buttons: TerminalShortcutButton[]) => {
      const current = queryClient.getQueryData<RuntimeSettings>(['settings']) ?? settings.data;
      if (!current) throw new LocalShellError(xRef.current('app.terminalSettingsUnavailable'));
      const next = await client.updateSettings(current, {
        terminal: { shortcutBarButtons: buttons },
      });
      queryClient.setQueryData(['settings'], next);
    },
    [client, queryClient, settings.data],
  );

  const updateMonitorSettings = useCallback(
    async (patch: Partial<RuntimeSettings['monitor']>) => {
      const current = queryClient.getQueryData<RuntimeSettings>(['settings']) ?? settings.data;
      if (!current) return;
      try {
        const next = await client.updateSettings(current, { monitor: patch });
        queryClient.setQueryData(['settings'], next);
      } catch (cause) {
        setTerminalError(shellErrorMessage(cause, xRef.current('app.saveMonitorSettingsError')));
      }
    },
    [client, queryClient, settings.data],
  );

  const sendActiveTerminalShortcut = useCallback((data: string) => {
    const terminalId = useWorkspace.getState().activeTerminalId;
    if (!terminalId) return false;
    return terminalViews.current.get(terminalId)?.sendShortcut(data) ?? false;
  }, []);

  const sendTerminalBatchInput = useCallback((terminalId: string, data: string) => {
    return terminalViews.current.get(terminalId)?.sendBatchInput(data) ?? false;
  }, []);

  const openAiWorkspace = useCallback(
    (draft: TerminalAiDraft) => {
      if (useWorkspace.getState().activeTerminalId !== draft.terminalId) return;
      setTerminalAiDraft(draft);
      setTerminalInformationOpen(false);
      showSection('ai');
    },
    [showSection],
  );
  const { requestAiCommandSuggestions, explainTerminalSelection } = useTerminalAiActions(
    client,
    aiModels.data,
    openAiWorkspace,
  );

  const createLocalTerminal = useCallback(
    async (
      profileId?: string,
      options?: {
        title?: string;
        bookmarkId?: string;
        initialDirectoryGrantId?: string;
        backgroundStartup?: boolean;
        replaceTerminalId?: string;
      },
    ) => {
      setTerminalError('');
      try {
        const effectiveProfileId = resolveTerminalProfileId(
          terminalProfiles.data,
          profileId,
          settings.data?.terminal.defaultProfileId,
        );
        const terminal = await client.createTerminal({
          kind: 'local',
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(options?.initialDirectoryGrantId
            ? {
                workingDirectory: {
                  scope: 'local' as const,
                  grantId: options.initialDirectoryGrantId,
                  path: '',
                },
              }
            : {}),
          cols: 160,
          rows: 80,
        });
        const workspace = useWorkspace.getState();
        const tab = {
          id: terminal.id,
          title:
            options?.title ??
            xRef.current('app.localTerminalTitle', {
              number: workspace.tabs.length + 1,
            }),
          kind: 'local' as const,
          ...(options?.bookmarkId ? { bookmarkId: options.bookmarkId } : {}),
          ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
          appearance: terminal.appearance,
          behavior: terminal.behavior,
          disconnected: false,
        };
        if (options?.replaceTerminalId) {
          replaceTerminal(options.replaceTerminalId, tab);
          setActiveTerminal(terminal.id);
        } else
          addTerminal(tab, {
            activateSurface: shouldActivateStartupSurface(options?.backgroundStartup),
          });
      } catch (error) {
        setTerminalError(shellErrorMessage(error, xRef.current('app.createLocalTerminalError')));
      } finally {
        if (options?.initialDirectoryGrantId)
          await client.revokeFileGrant(options.initialDirectoryGrantId).catch(() => undefined);
      }
    },
    [addTerminal, replaceTerminal, setActiveTerminal, client, settings.data, terminalProfiles.data],
  );

  async function openFilesInSession(connectionId?: string) {
    setTerminalError('');
    const workspace = useWorkspace.getState();
    const existing = connectionId
      ? workspace.tabs.find(
          (tab) => tab.kind === 'ssh' && tab.connectionId === connectionId && !tab.disconnected,
        )
      : (workspace.tabs.find(
          (tab) =>
            tab.id === workspace.activeTerminalId && (tab.kind === 'local' || tab.kind === 'ssh'),
        ) ??
        workspace.tabs.find(
          (tab) => (tab.kind === 'local' || tab.kind === 'ssh') && !tab.disconnected,
        ));
    if (existing) {
      setSection('files');
      if (existing.kind === 'ssh') useWorkspace.getState().setFileManagerView('split');
      setTerminalSessionMode(existing.id, 'files');
      return;
    }

    if (!connectionId) {
      await createLocalTerminal();
      const created = useWorkspace
        .getState()
        .tabs.find(
          (tab) => tab.id === useWorkspace.getState().activeTerminalId && tab.kind === 'local',
        );
      if (created) {
        setSection('files');
        setTerminalSessionMode(created.id, 'files');
      }
      return;
    }

    const connection = connections.data?.find(
      (candidate) => candidate.id === connectionId && candidate.state === 'ready',
    );
    if (!connection) {
      setTerminalError(xRef.current('app.connectHostFirst'));
      return;
    }
    try {
      const terminal = await client.createTerminal({
        kind: 'ssh',
        connectionId,
        cols: 160,
        rows: 80,
      });
      const host = hosts.data?.find((candidate) => candidate.id === connection.hostId);
      addTerminal({
        id: terminal.id,
        title: host?.name ?? connection.id.slice(0, 8),
        kind: 'ssh',
        hostId: connection.hostId,
        connectionId,
        ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
        appearance: terminal.appearance,
        behavior: terminal.behavior,
        disconnected: false,
      });
      setSection('files');
      useWorkspace.getState().setFileManagerView('split');
      setTerminalSessionMode(terminal.id, 'files');
    } catch (cause) {
      setTerminalError(shellErrorMessage(cause, xRef.current('app.connectRemoteError')));
    }
  }

  useEffect(() => {
    if (!status.data) return;
    const nextGeneration = status.data.metadata.generation;
    const changed = generation.current && generation.current !== nextGeneration;
    if (changed) {
      clearForGeneration();
      setRecoveryNotice({ kind: 'runtime-restarted', nonce: Date.now() });
      void queryClient.invalidateQueries();
    }
    if (generation.current !== nextGeneration) {
      reconnectTransitions.current.reset(nextGeneration);
      pendingRecoveredConnections.current.clear();
      activeConnectionReloads.current.clear();
      terminalReloadStates.current.clear();
      terminalViews.current.clear();
      setRequestedQuickConnect(undefined);
      setDeepLinkInitialCheckCompleted(false);
      if (retryingConnectionIdsRef.current.size) {
        retryingConnectionIdsRef.current.clear();
        setRetryingConnectionIds(new Set());
      }
      if (cancelingConnectionIdsRef.current.size) {
        cancelingConnectionIdsRef.current.clear();
        setCancelingConnectionIds(new Set());
      }
    }
    generation.current = nextGeneration;
  }, [clearForGeneration, queryClient, status.data]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('recovery'))
      window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    const offline = () => setRecoveryNotice({ kind: 'offline', nonce: Date.now() });
    const online = () => {
      client.reconnect();
      void queryClient.invalidateQueries();
      setRecoveryNotice({ kind: 'recovered', nonce: Date.now() });
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (!navigator.onLine) offline();
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [client, queryClient]);

  useEffect(() => {
    if (!recoveryNotice || !['recovered', 'resumed'].includes(recoveryNotice.kind)) return;
    const timer = window.setTimeout(() => setRecoveryNotice(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [recoveryNotice]);

  useEffect(
    () => () => {
      appDisposed.current = true;
      for (const controller of connectionWaits.current) controller.abort();
      connectionWaits.current.clear();
      reconnectTransitions.current.reset();
      pendingRecoveredConnections.current.clear();
      activeConnectionReloads.current.clear();
      retryingConnectionIdsRef.current.clear();
      cancelingConnectionIdsRef.current.clear();
      terminalReloadStates.current.clear();
      terminalViews.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (ready && generation.current && !requestedQuickConnect) void deepLinkDrain.current();
  }, [ready, requestedQuickConnect, status.data?.metadata.generation]);

  useEffect(() => {
    if (!settings.data || layoutHydrated) return;
    let canceled = false;
    const hydrate = async () => {
      let liveTerminalIds = new Set<string>();
      if (
        (settings.data.workspace.restoreLayout || restoringAfterRuntimeRestart.current) &&
        settings.data.workspace.layout
      ) {
        const configured = settings.data.workspace.startupSessions;
        const hasExplicitStartup =
          !restoringAfterRuntimeRestart.current &&
          (typeof configured === 'string' ? !!configured : configured.length > 0);
        if (hasExplicitStartup) {
          setAiInspector(settings.data.workspace.aiInspectorOpen);
          setLayoutHydrated(true);
          return;
        }
        try {
          const [terminalSessions, rdpSessions, vncSessions, spiceSessions, webSessions] =
            await Promise.all([
              client.terminals(),
              client.rdpSessions(),
              client.vncSessions(),
              client.spiceSessions(),
              client.webSessions(),
            ]);
          liveTerminalIds = new Set(
            [...terminalSessions, ...rdpSessions, ...vncSessions, ...spiceSessions, ...webSessions]
              .filter(({ state }) => state !== 'closed' && state !== 'failed')
              .map(({ id }) => id),
          );
        } catch {
          // Runtime restart recovery can retain a disconnected snapshot. A
          // normal cold start does not replay sessions from an old generation.
        }
      }
      if (canceled) return;
      const hasLiveLayout = !!settings.data.workspace.layout?.tabs.some(({ id }) =>
        liveTerminalIds.has(id),
      );
      setAiInspector(
        hasLiveLayout || restoringAfterRuntimeRestart.current
          ? settings.data.workspace.aiInspectorOpen
          : false,
      );
      if ((hasLiveLayout || restoringAfterRuntimeRestart.current) && settings.data.workspace.layout)
        restoreLayout(settings.data.workspace.layout, liveTerminalIds);
      setLayoutHydrated(true);
    };
    void hydrate();
    return () => {
      canceled = true;
    };
  }, [client, layoutHydrated, restoreLayout, setAiInspector, settings.data]);

  useEffect(() => {
    if (
      !ready ||
      !settings.data ||
      !layoutHydrated ||
      !deepLinkInitialCheckCompleted ||
      !!requestedQuickConnect ||
      (settings.data.terminal.defaultProfileId && !terminalProfiles.isFetched) ||
      !bookmarkTree.isFetched ||
      startupTerminalRequested.current
    )
      return;
    startupTerminalRequested.current = true;
    const startupSessions = restoringAfterRuntimeRestart.current
      ? []
      : settings.data.workspace.startupSessions;
    const hasExplicitStartup =
      typeof startupSessions === 'string' ? !!startupSessions : startupSessions.length > 0;
    const restoredLayout =
      !hasExplicitStartup &&
      (settings.data.workspace.restoreLayout || restoringAfterRuntimeRestart.current) &&
      !!settings.data.workspace.layout;
    const startupTabs = useWorkspace.getState().tabs;
    if (
      startupTabs.some((tab) => !tab.disconnected) ||
      (restoringAfterRuntimeRestart.current && startupTabs.length)
    )
      return;
    const staleLocal = !hasExplicitStartup
      ? startupTabs.find((tab) => tab.kind === 'local' && tab.disconnected)
      : undefined;
    window.queueMicrotask(() => {
      if (typeof startupSessions === 'string') {
        const workspace = settings.data?.workspace.namedWorkspaces.find(
          ({ id }) => id === startupSessions,
        );
        if (workspace) void startupWorkspaceLoader.current(workspace);
        else void createLocalTerminal(undefined, { backgroundStartup: true });
        return;
      }
      const bookmarks = startupSessions.flatMap((id) => {
        const bookmark = bookmarkTree.data?.bookmarks.find((candidate) => candidate.id === id);
        return bookmark ? [bookmark] : [];
      });
      if (!bookmarks.length)
        void createLocalTerminal(undefined, {
          backgroundStartup: !restoredLayout,
          ...(staleLocal ? { replaceTerminalId: staleLocal.id, title: staleLocal.title } : {}),
        });
      else for (const bookmark of bookmarks) startupBookmarkConnector.current(bookmark, true);
    });
  }, [
    createLocalTerminal,
    deepLinkInitialCheckCompleted,
    layoutHydrated,
    bookmarkTree.data,
    bookmarkTree.isFetched,
    ready,
    requestedQuickConnect,
    settings.data,
    terminalProfiles.isFetched,
  ]);

  useEffect(() => {
    if (!layoutHydrated || !settings.data || persistedLayoutWritePolicy !== 'active') return;
    const layout = {
      section,
      contentSurface,
      sidebarOpen,
      split,
      tabs: tabs.map(({ disconnected: _disconnected, ...tab }) => ({
        ...tab,
        pinned: tab.pinned ?? false,
        paneIndex: tab.paneIndex ?? 0,
      })),
      activeTerminalId: activeTerminalId ?? null,
      secondaryTerminalId: secondaryTerminalId ?? null,
      layoutMode,
      paneTerminalIds,
      focusedPane,
    };
    if (
      JSON.stringify({ aiInspectorOpen, layout }) ===
      JSON.stringify({
        aiInspectorOpen: settings.data.workspace.aiInspectorOpen,
        layout: settings.data.workspace.layout,
      })
    )
      return;
    const timer = window.setTimeout(() => {
      if (useWorkspace.getState().persistedLayoutWritePolicy !== 'active') return;
      void updateCachedSettings(queryClient, client, settings.data, {
        workspace: { aiInspectorOpen, layout },
      }).catch(() => void queryClient.invalidateQueries({ queryKey: ['settings'] }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    activeTerminalId,
    aiInspectorOpen,
    client,
    contentSurface,
    focusedPane,
    layoutMode,
    layoutHydrated,
    paneTerminalIds,
    persistedLayoutWritePolicy,
    queryClient,
    section,
    secondaryTerminalId,
    settings.data,
    sidebarOpen,
    split,
    tabs,
  ]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const invalidate = (type: string, data: unknown) => {
      if (type.startsWith('host-group.'))
        void queryClient.invalidateQueries({ queryKey: ['host-groups'] });
      else if (type.startsWith('host.'))
        void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      else if (type.startsWith('bookmark'))
        void queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] });
      else if (type.startsWith('connection-history.'))
        void queryClient.invalidateQueries({ queryKey: ['connection-history'] });
      else if (type.startsWith('connection.')) {
        if (type === 'connection.status' && generation.current) {
          const parsed = connectionSchema.safeParse(data);
          if (
            parsed.success &&
            reconnectTransitions.current.observe(generation.current, parsed.data)
          )
            addBounded(pendingRecoveredConnections.current, parsed.data.id);
        }
        void queryClient.invalidateQueries({ queryKey: ['connections'] });
      } else if (type.startsWith('transfer.'))
        void queryClient.invalidateQueries({ queryKey: ['transfers'] });
      else if (type.startsWith('tunnel.'))
        void queryClient.invalidateQueries({ queryKey: ['tunnels'] });
      else if (
        type.startsWith('quick-command.') ||
        type.startsWith('quick-command-group.') ||
        type.startsWith('quick-command-tree.')
      ) {
        void queryClient.invalidateQueries({ queryKey: ['quick-commands'] });
        void queryClient.invalidateQueries({ queryKey: ['quick-command-tree'] });
      } else if (type.startsWith('trigger.') || type.startsWith('trigger-list.')) {
        void queryClient.invalidateQueries({ queryKey: ['triggers'] });
        if (type === 'trigger.fired' && data && typeof data === 'object') {
          const event = data as { name?: unknown; actionType?: unknown };
          if (event.actionType === 'notify' && typeof event.name === 'string')
            setTerminalError(xRef.current('app.triggerNotification', { name: event.name }));
        } else if (type === 'trigger.session-disabled')
          setTerminalError(xRef.current('app.triggerLimitReached'));
      } else if (type.startsWith('command-history.'))
        void queryClient.invalidateQueries({ queryKey: ['command-history'] });
      else if (type.startsWith('terminal-profile.'))
        void queryClient.invalidateQueries({ queryKey: ['terminal-profiles'] });
      else if (type.startsWith('tunnel-profile.'))
        void queryClient.invalidateQueries({ queryKey: ['tunnel-profiles'] });
      else if (type.startsWith('ai-provider.'))
        void queryClient.invalidateQueries({ queryKey: ['ai-providers'] });
      else if (type.startsWith('ai-model.'))
        void queryClient.invalidateQueries({ queryKey: ['ai-models'] });
      else if (type.startsWith('ai-') || type.startsWith('ai.')) {
        if (type !== 'ai.run.delta' && type !== 'ai.run.usage')
          void queryClient.invalidateQueries({ queryKey: ['ai-runs'] });
      } else if (type.startsWith('interaction.'))
        void queryClient.invalidateQueries({ queryKey: ['interactions'] });
      else if (type.startsWith('settings.'))
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
      else if (type === 'desktop.lifecycle') {
        const lifecycle = desktopLifecycleStateSchema.safeParse(data);
        if (lifecycle.success && lifecycle.data.lastEvent === 'resume') {
          client.reconnect();
          void queryClient.invalidateQueries();
          setRecoveryNotice({ kind: 'resumed', nonce: lifecycle.data.revision });
        }
      } else if (type === 'deep-link.available') void deepLinkDrain.current();
    };
    for (const kind of ['domain', 'realtime'] as const)
      void client
        .eventStream(kind, ({ type, data }) => invalidate(type, data), controller.signal)
        .catch(() => {});
    return () => controller.abort();
  }, [client, queryClient, ready, status.data?.metadata.generation]);

  useEffect(() => {
    const element = tabbar.current;
    if (!element) return;
    const update = () => setTabOverflow(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [tabs.length]);

  function runShortcutAction(action: ShortcutActionId): boolean {
    if (shortcutUnavailableReason(action, shortcutContext())) return false;
    const workspace = useWorkspace.getState();
    const activeId = workspace.activeTerminalId;
    const current = activeId ? workspace.tabs.find(({ id }) => id === activeId) : undefined;
    switch (action) {
      case 'app_closeCurrentTab':
        if (!activeId) return false;
        void closeTab(activeId);
        return true;
      case 'app_mouseWheelDownCloseTab':
        return false;
      case 'app_reloadCurrentTab':
        if (!activeId) return false;
        void reloadTab(activeId);
        return true;
      case 'app_reloadAll':
        if (!workspace.tabs.length) return false;
        void reloadTabs(workspace.tabs.map(({ id }) => id));
        return true;
      case 'app_cloneToNextLayout':
        if (!activeId) return false;
        void cloneTabToNextPane(activeId);
        return true;
      case 'app_duplicateTab':
        if (!activeId) return false;
        void duplicateTab(activeId);
        return true;
      case 'app_newBookmark':
        openNewBookmark();
        return true;
      case 'app_newTab':
        void createLocalTerminal();
        return true;
      case 'app_toggleAddBtn':
        setNewSessionMenuOpen((open) => !open);
        setLayoutMenuOpen(false);
        setTabOverflowMenuOpen(false);
        return true;
      case 'app_togglefullscreen':
        void client
          .performWindowAction('toggle-fullscreen')
          .catch((cause: unknown) =>
            setTerminalError(shellErrorMessage(cause, xRef.current('app.toggleFullscreenError'))),
          );
        return true;
      case 'app_zoomin':
        void changeWindowZoom(0.1);
        return true;
      case 'app_zoomout':
        void changeWindowZoom(-0.1);
        return true;
      case 'app_prevTab':
        return selectRelativeTab(-1);
      case 'app_nextTab':
        return selectRelativeTab(1);
      case 'terminal_syncSftpPath': {
        if (current?.kind !== 'ssh' || !current.connectionId) return false;
        const cwd = terminalViews.current.get(current.id)?.getCwd();
        if (!cwd?.startsWith('/')) {
          setTerminalError(xRef.current('app.sftpPathUnavailable'));
          return true;
        }
        setRequestedSftpDirectory({
          connectionId: current.connectionId,
          path: cwd,
          nonce: crypto.randomUUID(),
        });
        useWorkspace.getState().setFileManagerView('remote');
        setTerminalSessionMode(current.id, 'files');
        return true;
      }
      default:
        if (!activeId) return false;
        return (
          terminalViews.current
            .get(activeId)
            ?.runShortcutAction(action as Extract<ShortcutActionId, `terminal_${string}`>) ?? false
        );
    }
  }

  function selectRelativeTab(direction: -1 | 1): boolean {
    const workspace = useWorkspace.getState();
    const batch = paneTabsInDisplayOrder(workspace.tabs, workspace.focusedPane);
    if (!batch.length) return false;
    const current = batch.findIndex(({ id }) => id === workspace.activeTerminalId);
    const origin = current < 0 ? (direction > 0 ? -1 : 0) : current;
    const index = (origin + direction + batch.length) % batch.length;
    setActiveTerminal(batch[index]?.id);
    return true;
  }

  async function changeWindowZoom(delta: number) {
    try {
      const current = await client.windowPreferences();
      const zoomFactor = Math.max(
        0.5,
        Math.min(8, Math.round((current.preferences.zoomFactor + delta) * 10) / 10),
      );
      if (zoomFactor !== current.preferences.zoomFactor)
        await client.updateWindowPreferences({ zoomFactor });
    } catch (cause) {
      setTerminalError(shellErrorMessage(cause, xRef.current('app.windowZoomError')));
    }
  }

  async function openHostTerminal(
    host: Host,
    temporarySecret?: string,
    profileId?: string,
    requestedConnectionProfileId?: string,
    requestedBookmarkId?: string,
    quickOptions?: {
      title?: string;
      environment?: Readonly<Record<string, string>>;
      initialDirectoryGrantId?: string;
      enableSsh?: boolean;
      enableSftp?: boolean;
      backgroundStartup?: boolean;
    },
  ) {
    setTerminalError('');
    try {
      const bookmark = requestedBookmarkId
        ? bookmarkTree.data?.bookmarks.find(({ id }) => id === requestedBookmarkId)
        : bookmarkTree.data?.bookmarks.find(
            (candidate) =>
              candidate.hostId === host.id &&
              (!requestedConnectionProfileId ||
                candidate.connectionProfileId === requestedConnectionProfileId),
          );
      const connectionProfileId =
        requestedConnectionProfileId ?? bookmark?.connectionProfileId ?? undefined;
      const existing = (await client.connections()).find(
        (connection) =>
          connection.hostId === host.id &&
          (connection.connectionProfileId ?? undefined) === connectionProfileId &&
          connection.state === 'ready',
      );
      const connection =
        existing ??
        (await client.createConnection(host.id, temporarySecret, undefined, connectionProfileId));
      await waitForConnection(connection.id);
      const effectiveProfileId = resolveTerminalProfileId(
        terminalProfiles.data,
        profileId,
        settings.data?.terminal.defaultProfileId,
      );
      if (quickOptions?.enableSsh !== false) {
        const terminal = await client.createTerminal({
          kind: 'ssh',
          connectionId: connection.id,
          ...(bookmark ? { bookmarkId: bookmark.id } : {}),
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(quickOptions?.environment ? { environment: { ...quickOptions.environment } } : {}),
          cols: 160,
          rows: 80,
        });
        addTerminal(
          {
            id: terminal.id,
            title: quickOptions?.title ?? host.name,
            kind: 'ssh',
            hostId: host.id,
            ...(bookmark ? { bookmarkId: bookmark.id } : {}),
            connectionId: connection.id,
            ...(connectionProfileId ? { connectionProfileId } : {}),
            ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
            appearance: terminal.appearance,
            behavior: terminal.behavior,
            disconnected: false,
          },
          { activateSurface: shouldActivateStartupSurface(quickOptions?.backgroundStartup) },
        );
      }
      if (quickOptions?.initialDirectoryGrantId)
        setInitialFileDirectoryGrantId(quickOptions.initialDirectoryGrantId);
      if (
        (quickOptions?.enableSsh === false && quickOptions.enableSftp !== false) ||
        quickOptions?.initialDirectoryGrantId
      )
        showSection('files');
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (error) {
      if (quickOptions?.initialDirectoryGrantId)
        await client.revokeFileGrant(quickOptions.initialDirectoryGrantId).catch(() => undefined);
      setTerminalError(shellErrorMessage(error, xRef.current('app.connectRemoteError')));
    }
  }

  async function waitForConnection(connectionId: string, expectedGeneration?: string) {
    const controller = new AbortController();
    connectionWaits.current.add(controller);
    try {
      return await waitForConnectionReady(
        {
          list: client.connections,
          isDisposed: () => appDisposed.current,
          generation: () => generation.current,
          signal: controller.signal,
          x: (key, variables) => xRef.current(key, variables),
        },
        connectionId,
        expectedGeneration,
      );
    } finally {
      connectionWaits.current.delete(controller);
    }
  }

  async function openHistoryTerminal(item: ConnectionHistoryItem, pending: Connection) {
    const connection = await waitForConnection(pending.id);
    const bookmark = item.hostId
      ? bookmarkTree.data?.bookmarks.find(({ hostId }) => hostId === item.hostId)
      : undefined;
    const profileId = resolveTerminalProfileId(
      terminalProfiles.data,
      bookmark?.profileId,
      settings.data?.terminal.defaultProfileId,
    );
    const terminal = await client.createTerminal({
      kind: 'ssh',
      connectionId: connection.id,
      ...(bookmark ? { bookmarkId: bookmark.id } : {}),
      ...(profileId ? { profileId } : {}),
      cols: 160,
      rows: 80,
    });
    addTerminal({
      id: terminal.id,
      title: bookmark?.title ?? item.name,
      kind: 'ssh',
      ...(item.hostId ? { hostId: item.hostId } : {}),
      ...(bookmark ? { bookmarkId: bookmark.id } : {}),
      connectionId: connection.id,
      ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
      appearance: terminal.appearance,
      behavior: terminal.behavior,
      disconnected: false,
    });
  }

  async function quickConnect(target: QuickConnectTarget, profileId?: string) {
    if (target.protocol === 'local') {
      if (target.batchOperationGrantId) {
        const grantId = target.batchOperationGrantId;
        setTerminalError('');
        try {
          const granted = await client.readGrantedText(grantId);
          const request = parseCommandLineBatchOperation(granted.content, xRef.current);
          const operation = await client.createBatchOperation(request);
          queryClient.setQueryData(['batch-operations'], (current: unknown) =>
            Array.isArray(current)
              ? [operation, ...current.filter((item) => item?.id !== operation.id)]
              : [operation],
          );
          setCommandWorkspaceSection('batch-operations');
          showSection('commands');
        } catch (error) {
          setTerminalError(shellErrorMessage(error, xRef.current('app.batchCliError')));
          setCommandWorkspaceSection('batch-operations');
          showSection('commands');
        } finally {
          await client.revokeFileGrant(grantId).catch(() => undefined);
        }
        return;
      }
      await createLocalTerminal(profileId, {
        ...(target.title ? { title: target.title } : {}),
        ...(target.initialDirectoryGrantId
          ? { initialDirectoryGrantId: target.initialDirectoryGrantId }
          : {}),
      });
      return;
    }
    if (target.protocol !== 'ssh') {
      setBookmarkEditId(undefined);
      setBookmarkCreateRequested(false);
      setRequestedQuickConnect(target);
      openBookmarkManager();
      return;
    }
    const known = hosts.data?.find(
      (host) =>
        host.hostname === target.hostname &&
        host.port === target.port &&
        (!target.username || host.username === target.username),
    );
    if (known && !target.credentialGrantId) {
      await openHostTerminal(known, target.temporarySecret, profileId, undefined, undefined, {
        ...(target.title ? { title: target.title } : {}),
        ...(target.environment ? { environment: target.environment } : {}),
        ...(target.initialDirectoryGrantId
          ? { initialDirectoryGrantId: target.initialDirectoryGrantId }
          : {}),
        enableSsh: target.enableSsh,
        enableSftp: target.enableSftp,
      });
      return;
    }
    setTerminalError('');
    try {
      const connection = await client.createQuickConnection(
        {
          name: target.title ?? target.hostname,
          hostname: target.hostname,
          port: target.port,
          username: target.username ?? 'root',
          authType: target.credentialGrantId
            ? 'privateKey'
            : target.temporarySecret
              ? 'password'
              : target.authType,
        },
        target.temporarySecret,
        target.temporaryPassphrase,
        undefined,
        target.credentialGrantId,
      );
      await waitForConnection(connection.id);
      const effectiveProfileId = resolveTerminalProfileId(
        terminalProfiles.data,
        profileId,
        settings.data?.terminal.defaultProfileId,
      );
      if (target.enableSsh) {
        const terminal = await client.createTerminal({
          kind: 'ssh',
          connectionId: connection.id,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          ...(target.environment ? { environment: { ...target.environment } } : {}),
          cols: 160,
          rows: 80,
        });
        addTerminal({
          id: terminal.id,
          title: target.title ?? target.hostname,
          kind: 'ssh',
          connectionId: connection.id,
          ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
          appearance: terminal.appearance,
          behavior: terminal.behavior,
          disconnected: false,
        });
      }
      if (target.initialDirectoryGrantId)
        setInitialFileDirectoryGrantId(target.initialDirectoryGrantId);
      if ((!target.enableSsh && target.enableSftp) || target.initialDirectoryGrantId)
        showSection('files');
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (error) {
      if (target.initialDirectoryGrantId)
        await client.revokeFileGrant(target.initialDirectoryGrantId).catch(() => undefined);
      setTerminalError(shellErrorMessage(error, xRef.current('app.quickConnectError')));
    }
  }

  async function drainDeepLinks() {
    if (deepLinkDrainActive.current) {
      deepLinkDrainRequested.current = true;
      return;
    }
    if (!generation.current || requestedQuickConnect) return;
    deepLinkDrainActive.current = true;
    let waitingForEditor = false;
    try {
      for (let index = 0; index < 32; index += 1) {
        const intent = await client.nextDeepLinkIntent();
        if (!intent) return;
        if (intent.status === 'rejected' || !intent.source) {
          setTerminalError(xRef.current('app.invalidDeepLink'));
          continue;
        }
        const target = parseQuickConnect(intent.source);
        if (!target) {
          setTerminalError(xRef.current('app.invalidDeepLink'));
          continue;
        }
        if (target.protocol === 'ssh' || target.protocol === 'local') await quickConnect(target);
        else {
          setBookmarkEditId(undefined);
          setBookmarkCreateRequested(false);
          setRequestedQuickConnect(target);
          openBookmarkManager();
          waitingForEditor = true;
          return;
        }
      }
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.deepLinkError')));
    } finally {
      deepLinkDrainActive.current = false;
      setDeepLinkInitialCheckCompleted(true);
      if (deepLinkDrainRequested.current && !waitingForEditor) {
        deepLinkDrainRequested.current = false;
        queueMicrotask(() => void deepLinkDrain.current());
      }
    }
  }
  useLayoutEffect(() => {
    deepLinkDrain.current = drainDeepLinks;
  });

  async function updateBookmarkTree(
    mutation: (tree: BookmarkTreeValue) => Promise<BookmarkTreeValue>,
  ): Promise<boolean> {
    const tree =
      queryClient.getQueryData<BookmarkTreeValue>(['bookmark-tree']) ?? bookmarkTree.data;
    if (!tree || bookmarkBusy) return false;
    setBookmarkBusy(true);
    setTerminalError('');
    try {
      queryClient.setQueryData(['bookmark-tree'], await mutation(tree));
      return true;
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.bookmarkTreeError')));
      await queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] });
      return false;
    } finally {
      setBookmarkBusy(false);
    }
  }

  function createBookmarkGroup(parentId: string | null) {
    setBookmarkGroupDialog({ kind: 'create', parentId });
  }

  function renameBookmarkGroup(id: string) {
    const group = bookmarkTree.data?.groups.find((item) => item.id === id);
    if (!group) return;
    setBookmarkGroupDialog({
      kind: 'rename',
      id,
      initialValue: { name: group.name, color: group.color, description: group.description },
    });
  }

  function deleteBookmarkGroup(id: string) {
    const group = bookmarkTree.data?.groups.find((item) => item.id === id);
    if (!group || !window.confirm(xRef.current('app.deleteGroupConfirm', { name: group.name })))
      return;
    void updateBookmarkTree((tree) => client.deleteBookmarkGroup(tree, id));
  }

  function moveBookmarkTreeNode(
    source: BookmarkTreeNodeRef,
    target: BookmarkTreeNodeRef,
    position: BookmarkDropPosition,
  ) {
    void updateBookmarkTree((tree) =>
      client.moveBookmarkTreeNode(tree, { source, target, position }),
    );
  }

  async function openSshConfigImport() {
    if (!bookmarkTree.data || sshConfigImportGrant) return;
    setTerminalError('');
    try {
      const grant = await client.createFileGrant('open-file');
      if (grant) setSshConfigImportGrant(grant);
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.sshConfigGrantError')));
    }
  }

  function connectBookmark(bookmark: Bookmark, backgroundStartup = false) {
    const addConnectedTerminal = (tab: TerminalTab) =>
      addTerminal(tab, { activateSurface: shouldActivateStartupSurface(backgroundStartup) });
    if (bookmark.protocol === 'local') {
      void createLocalTerminal(bookmark.profileId ?? undefined, {
        title: bookmark.title,
        bookmarkId: bookmark.id,
        backgroundStartup,
      });
      return;
    }
    if (bookmark.protocol === 'ssh' && bookmark.hostId) {
      const host = hosts.data?.find((item) => item.id === bookmark.hostId);
      if (host) {
        void openHostTerminal(
          host,
          undefined,
          bookmark.profileId ?? undefined,
          bookmark.connectionProfileId ?? undefined,
          bookmark.id,
          { backgroundStartup },
        );
        return;
      }
    }
    if (bookmark.protocol === 'ftp' && bookmark.ftp) {
      setTerminalError('');
      void client
        .createFtpConnection(bookmark.id)
        .then(async (connection) => {
          setActiveFtpConnection(connection.id);
          await queryClient.invalidateQueries({ queryKey: ['ftp-connections'] });
          if (shouldActivateStartupSurface(backgroundStartup)) showSection('files');
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(error, xRef.current('app.protocolConnectError', { protocol: 'FTP' })),
          ),
        );
      return;
    }
    if (bookmark.protocol === 'telnet' && bookmark.telnet) {
      setTerminalError('');
      const effectiveProfileId = resolveTerminalProfileId(
        terminalProfiles.data,
        bookmark.profileId ?? undefined,
        settings.data?.terminal.defaultProfileId,
      );
      void client
        .createTerminal({
          kind: 'telnet',
          bookmarkId: bookmark.id,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          cols: 160,
          rows: 80,
        })
        .then((terminal) => {
          addConnectedTerminal({
            id: terminal.id,
            title: bookmark.title,
            kind: 'telnet',
            bookmarkId: bookmark.id,
            ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
            appearance: terminal.appearance,
            behavior: terminal.behavior,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(
              error,
              xRef.current('app.protocolConnectError', { protocol: 'Telnet' }),
            ),
          ),
        );
      return;
    }
    if (bookmark.protocol === 'serial' && bookmark.serial) {
      setTerminalError('');
      const effectiveProfileId = resolveTerminalProfileId(
        terminalProfiles.data,
        bookmark.profileId ?? undefined,
        settings.data?.terminal.defaultProfileId,
      );
      void client
        .createTerminal({
          kind: 'serial',
          bookmarkId: bookmark.id,
          ...(effectiveProfileId ? { profileId: effectiveProfileId } : {}),
          cols: 160,
          rows: 80,
        })
        .then((terminal) => {
          addConnectedTerminal({
            id: terminal.id,
            title: bookmark.title,
            kind: 'serial',
            bookmarkId: bookmark.id,
            ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
            appearance: terminal.appearance,
            behavior: terminal.behavior,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(shellErrorMessage(error, xRef.current('app.serialOpenError'))),
        );
      return;
    }
    if (bookmark.protocol === 'rdp' && bookmark.rdp) {
      setTerminalError('');
      void client
        .createRdpSession({ bookmarkId: bookmark.id })
        .then((session) => {
          addConnectedTerminal({
            id: session.id,
            title: bookmark.title,
            kind: 'rdp',
            bookmarkId: bookmark.id,
            connectionProfileId: bookmark.connectionProfileId ?? undefined,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(
              error,
              xRef.current('app.protocolSessionCreateError', { protocol: 'RDP' }),
            ),
          ),
        );
      return;
    }
    if (bookmark.protocol === 'vnc' && bookmark.vnc) {
      setTerminalError('');
      void client
        .createVncSession({ bookmarkId: bookmark.id })
        .then((session) => {
          addConnectedTerminal({
            id: session.id,
            title: bookmark.title,
            kind: 'vnc',
            bookmarkId: bookmark.id,
            connectionProfileId: bookmark.connectionProfileId ?? undefined,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(
              error,
              xRef.current('app.protocolSessionCreateError', { protocol: 'VNC' }),
            ),
          ),
        );
      return;
    }
    if (bookmark.protocol === 'spice' && bookmark.spice) {
      setTerminalError('');
      void client
        .createSpiceSession({ bookmarkId: bookmark.id })
        .then((session) => {
          addConnectedTerminal({
            id: session.id,
            title: bookmark.title,
            kind: 'spice',
            bookmarkId: bookmark.id,
            connectionProfileId: bookmark.connectionProfileId ?? undefined,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(
              error,
              xRef.current('app.protocolSessionCreateError', { protocol: 'SPICE' }),
            ),
          ),
        );
      return;
    }
    if (bookmark.protocol === 'web' && bookmark.web) {
      setTerminalError('');
      void client
        .createWebSession({ bookmarkId: bookmark.id })
        .then((session) => {
          addConnectedTerminal({
            id: session.id,
            title: bookmark.title,
            kind: 'web',
            bookmarkId: bookmark.id,
            disconnected: false,
          });
        })
        .catch((error: unknown) =>
          setTerminalError(
            shellErrorMessage(
              error,
              xRef.current('app.protocolSessionCreateError', { protocol: 'Web' }),
            ),
          ),
        );
      return;
    }
    setTerminalError(
      xRef.current('app.bookmarkProtocolUnavailable', {
        protocol: bookmark.protocol.toUpperCase(),
      }),
    );
  }

  function editBookmark(bookmark: Bookmark) {
    if (
      bookmark.protocol !== 'ftp' &&
      bookmark.protocol !== 'telnet' &&
      bookmark.protocol !== 'serial' &&
      bookmark.protocol !== 'rdp' &&
      bookmark.protocol !== 'vnc' &&
      bookmark.protocol !== 'spice' &&
      bookmark.protocol !== 'web' &&
      (bookmark.protocol !== 'ssh' || !bookmark.hostId)
    ) {
      setTerminalError(
        xRef.current('app.bookmarkEditorUnavailable', {
          protocol: bookmark.protocol.toUpperCase(),
        }),
      );
      return;
    }
    setBookmarkEditId(bookmark.id);
    openBookmarkManager();
  }

  async function duplicateBookmark(bookmark: Bookmark) {
    const tree =
      queryClient.getQueryData<BookmarkTreeValue>(['bookmark-tree']) ?? bookmarkTree.data;
    if (!tree || bookmarkBusy) return;
    setBookmarkBusy(true);
    setTerminalError('');
    try {
      const title = duplicateBookmarkTitle(tree, bookmark.title, xRef.current('app.copyNoun'));
      if (bookmark.protocol === 'ssh' && bookmark.hostId) {
        const host = hosts.data?.find(({ id }) => id === bookmark.hostId);
        if (!host) throw new LocalShellError(xRef.current('app.sshBookmarkHostMissing'));
        const result = await client.createSshBookmark(tree, {
          host: {
            name: duplicateBookmarkTitle(tree, host.name, xRef.current('app.copyNoun')),
            hostname: host.hostname,
            port: host.port,
            username: host.username,
            authType: host.authType,
            credentialRef: host.credentialRef,
            passphraseCredentialRef: host.passphraseCredentialRef,
            certificateCredentialRef: host.certificateCredentialRef,
            jumpHostId: host.jumpHostId,
            jumpHostIds: host.jumpHostIds,
            favorite: host.favorite,
            proxy: host.proxy,
            connectionOptions: host.connectionOptions,
            startup: host.startup,
            x11: host.x11,
            sshAgent: host.sshAgent,
          },
          bookmark: {
            groupId: bookmark.groupId,
            title,
            color: bookmark.color,
            description: bookmark.description,
            profileId: bookmark.profileId,
            connectionProfileId: bookmark.connectionProfileId,
            quickCommands: bookmark.quickCommands,
            triggers: bookmark.triggers,
          },
        });
        queryClient.setQueryData(['bookmark-tree'], result.tree);
        await queryClient.invalidateQueries({ queryKey: ['hosts'] });
      } else {
        queryClient.setQueryData(
          ['bookmark-tree'],
          await client.createBookmark(tree, {
            groupId: bookmark.groupId,
            protocol: bookmark.protocol,
            hostId: null,
            title,
            color: bookmark.color,
            description: bookmark.description,
            profileId: bookmark.profileId,
            connectionProfileId: bookmark.connectionProfileId,
            quickCommands: bookmark.quickCommands,
            triggers: bookmark.triggers,
            ftp: bookmark.ftp,
            telnet: bookmark.telnet,
            serial: bookmark.serial,
            rdp: bookmark.rdp,
            vnc: bookmark.vnc,
            spice: bookmark.spice,
            web: bookmark.web,
          }),
        );
      }
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.duplicateBookmarkError')));
      await queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] });
    } finally {
      setBookmarkBusy(false);
    }
  }

  async function deleteBookmark(bookmark: Bookmark) {
    if (!window.confirm(xRef.current('app.deleteBookmarkConfirm', { title: bookmark.title })))
      return;
    const tree =
      queryClient.getQueryData<BookmarkTreeValue>(['bookmark-tree']) ?? bookmarkTree.data;
    if (!tree || bookmarkBusy) return;
    setBookmarkBusy(true);
    setTerminalError('');
    try {
      if (bookmark.protocol === 'ssh' && bookmark.hostId) {
        const host = hosts.data?.find(({ id }) => id === bookmark.hostId);
        if (!host) throw new LocalShellError(xRef.current('app.sshBookmarkHostMissing'));
        const result = await client.deleteSshBookmark(tree, host, bookmark.id);
        queryClient.setQueryData(['bookmark-tree'], result.tree);
        if (result.hostDeleted) {
          const references = [
            host.credentialRef,
            host.passphraseCredentialRef,
            host.certificateCredentialRef,
            ...proxyCredentialRefs(host.proxy),
          ].filter(
            (value): value is string =>
              !!value &&
              !hosts.data?.some(
                (candidate) =>
                  candidate.id !== host.id &&
                  (candidate.credentialRef === value ||
                    candidate.passphraseCredentialRef === value ||
                    candidate.certificateCredentialRef === value ||
                    proxyCredentialRefs(candidate.proxy).includes(value)),
              ),
          );
          await Promise.allSettled(
            [...new Set(references)].map((reference) => client.deleteCredential(reference)),
          );
        }
        await queryClient.invalidateQueries({ queryKey: ['hosts'] });
        await queryClient.invalidateQueries({ queryKey: ['connections'] });
      } else {
        queryClient.setQueryData(['bookmark-tree'], await client.deleteBookmark(tree, bookmark.id));
        const credentialRefs = [
          bookmark.ftp?.credentialRef,
          bookmark.telnet?.credentialRef,
          bookmark.rdp?.credentialRef,
          bookmark.vnc?.credentialRef,
          bookmark.spice?.credentialRef,
          ...proxyCredentialRefs(bookmark.rdp?.proxy),
          ...proxyCredentialRefs(bookmark.vnc?.proxy),
          ...proxyCredentialRefs(bookmark.spice?.proxy),
        ].filter((value): value is string => !!value);
        await Promise.allSettled(
          credentialRefs
            .filter(
              (credentialRef) =>
                !tree.bookmarks.some(
                  (candidate) =>
                    candidate.id !== bookmark.id &&
                    (candidate.ftp?.credentialRef === credentialRef ||
                      candidate.telnet?.credentialRef === credentialRef ||
                      candidate.rdp?.credentialRef === credentialRef ||
                      candidate.vnc?.credentialRef === credentialRef ||
                      candidate.spice?.credentialRef === credentialRef ||
                      proxyCredentialRefs(candidate.rdp?.proxy).includes(credentialRef) ||
                      proxyCredentialRefs(candidate.vnc?.proxy).includes(credentialRef) ||
                      proxyCredentialRefs(candidate.spice?.proxy).includes(credentialRef)),
                ),
            )
            .map((credentialRef) => client.deleteCredential(credentialRef)),
        );
      }
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.deleteBookmarkError')));
      await queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] });
    } finally {
      setBookmarkBusy(false);
    }
  }

  async function duplicateTab(id: string): Promise<string | undefined> {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return undefined;
    setTerminalError('');
    try {
      if (tab.kind === 'rdp') {
        if (!tab.bookmarkId)
          throw new LocalShellError(
            xRef.current('app.sessionBookmarkMissing', { protocol: 'RDP' }),
          );
        const session = await client.createRdpSession({ bookmarkId: tab.bookmarkId });
        insertTerminalAfter(id, { ...tab, id: session.id, disconnected: false });
        return session.id;
      }
      if (tab.kind === 'vnc') {
        if (!tab.bookmarkId)
          throw new LocalShellError(
            xRef.current('app.sessionBookmarkMissing', { protocol: 'VNC' }),
          );
        const session = await client.createVncSession({ bookmarkId: tab.bookmarkId });
        insertTerminalAfter(id, { ...tab, id: session.id, disconnected: false });
        return session.id;
      }
      if (tab.kind === 'spice') {
        if (!tab.bookmarkId)
          throw new LocalShellError(
            xRef.current('app.sessionBookmarkMissing', { protocol: 'SPICE' }),
          );
        const session = await client.createSpiceSession({ bookmarkId: tab.bookmarkId });
        insertTerminalAfter(id, { ...tab, id: session.id, disconnected: false });
        return session.id;
      }
      if (tab.kind === 'web') {
        if (!tab.bookmarkId)
          throw new LocalShellError(
            xRef.current('app.sessionBookmarkMissing', { protocol: 'Web' }),
          );
        const session = await client.createWebSession({ bookmarkId: tab.bookmarkId });
        insertTerminalAfter(id, { ...tab, id: session.id, disconnected: false });
        return session.id;
      }
      const { terminal, connectionId } = await createTerminalForTab(tab);
      insertTerminalAfter(id, {
        id: terminal.id,
        title: tab.title,
        kind: tab.kind,
        ...(tab.hostId ? { hostId: tab.hostId } : {}),
        ...(connectionId ? { connectionId } : {}),
        ...(tab.bookmarkId ? { bookmarkId: tab.bookmarkId } : {}),
        ...(tab.connectionProfileId ? { connectionProfileId: tab.connectionProfileId } : {}),
        ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
        appearance: terminal.appearance,
        behavior: terminal.behavior,
        disconnected: false,
        pinned: tab.pinned ?? false,
        paneIndex: paneOf(tab),
      });
      return terminal.id;
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.duplicateSessionError')));
      return undefined;
    }
  }

  async function reloadTab(
    id: string,
    preferredConnectionId?: string,
    expectedGeneration = generation.current,
  ) {
    const tab = useWorkspace.getState().tabs.find((item) => item.id === id);
    if (!tab) return;
    if (tab.kind === 'rdp') {
      await reloadRdpTab(tab);
      return;
    }
    if (tab.kind === 'vnc') {
      await reloadVncTab(tab);
      return;
    }
    if (tab.kind === 'spice') {
      await reloadSpiceTab(tab);
      return;
    }
    if (tab.kind === 'web') {
      await reloadWebTab(tab);
      return;
    }
    const reloadState = captureTerminalReloadState(tab);
    setTerminalError('');
    try {
      const { terminal, connectionId } = await createTerminalForTab(tab, preferredConnectionId);
      if (
        appDisposed.current ||
        (expectedGeneration !== undefined && generation.current !== expectedGeneration)
      ) {
        await client.closeTerminal(terminal.id).catch(() => {});
        return;
      }
      terminalReloadStates.current.set(terminal.id, reloadState);
      replaceTerminal(id, {
        ...tab,
        id: terminal.id,
        ...(connectionId ? { connectionId } : {}),
        ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
        appearance: terminal.appearance,
        behavior: terminal.behavior,
        disconnected: false,
      });
      await client.closeTerminal(id).catch(() => {});
    } catch (error) {
      if (
        !appDisposed.current &&
        (expectedGeneration === undefined || generation.current === expectedGeneration)
      )
        setTerminalError(shellErrorMessage(error, xRef.current('app.reconnectSessionError')));
    }
  }

  async function reloadRdpTab(tab: TerminalTab) {
    if (tab.kind !== 'rdp' || !tab.bookmarkId) {
      setTerminalError(xRef.current('app.sessionBookmarkMissing', { protocol: 'RDP' }));
      return;
    }
    setTerminalError('');
    try {
      const session = await client.createRdpSession({ bookmarkId: tab.bookmarkId });
      replaceTerminal(tab.id, { ...tab, id: session.id, disconnected: false });
      await client.closeRdpSession(tab.id).catch(() => undefined);
    } catch (error) {
      setTerminalError(
        shellErrorMessage(
          error,
          xRef.current('app.reconnectProtocolSessionError', { protocol: 'RDP' }),
        ),
      );
    }
  }

  async function reloadVncTab(tab: TerminalTab) {
    if (tab.kind !== 'vnc' || !tab.bookmarkId) {
      setTerminalError(xRef.current('app.sessionBookmarkMissing', { protocol: 'VNC' }));
      return;
    }
    setTerminalError('');
    try {
      const session = await client.createVncSession({ bookmarkId: tab.bookmarkId });
      replaceTerminal(tab.id, { ...tab, id: session.id, disconnected: false });
      await client.closeVncSession(tab.id).catch(() => undefined);
    } catch (error) {
      setTerminalError(
        shellErrorMessage(
          error,
          xRef.current('app.reconnectProtocolSessionError', { protocol: 'VNC' }),
        ),
      );
    }
  }

  async function reloadSpiceTab(tab: TerminalTab) {
    if (tab.kind !== 'spice' || !tab.bookmarkId) {
      setTerminalError(xRef.current('app.sessionBookmarkMissing', { protocol: 'SPICE' }));
      return;
    }
    setTerminalError('');
    try {
      const session = await client.createSpiceSession({ bookmarkId: tab.bookmarkId });
      replaceTerminal(tab.id, { ...tab, id: session.id, disconnected: false });
      await client.closeSpiceSession(tab.id).catch(() => undefined);
    } catch (error) {
      setTerminalError(
        shellErrorMessage(
          error,
          xRef.current('app.reconnectProtocolSessionError', { protocol: 'SPICE' }),
        ),
      );
    }
  }

  async function reloadWebTab(tab: TerminalTab) {
    if (tab.kind !== 'web' || !tab.bookmarkId) {
      setTerminalError(xRef.current('app.sessionBookmarkMissing', { protocol: 'Web' }));
      return;
    }
    setTerminalError('');
    try {
      const session = await client.createWebSession({ bookmarkId: tab.bookmarkId });
      replaceTerminal(tab.id, { ...tab, id: session.id, disconnected: false });
      await client.closeWebSession(tab.id).catch(() => undefined);
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.reloadWebSessionError')));
    }
  }

  async function createTerminalForTab(tab: TerminalTab, preferredConnectionId?: string) {
    if (tab.kind === 'rdp' || tab.kind === 'vnc' || tab.kind === 'spice')
      throw new LocalShellError(
        xRef.current('app.remoteDesktopLifecycle', { protocol: tab.kind.toUpperCase() }),
      );
    if (tab.kind === 'web') throw new LocalShellError(xRef.current('app.webLifecycle'));
    if (tab.kind === 'local') {
      return {
        terminal: await client.createTerminal({
          kind: 'local',
          ...(tab.profileId ? { profileId: tab.profileId } : {}),
          cols: 160,
          rows: 80,
        }),
        connectionId: undefined,
      };
    }

    if (tab.kind === 'telnet') {
      if (!tab.bookmarkId)
        throw new LocalShellError(
          xRef.current('app.protocolBookmarkReconnect', { protocol: 'Telnet' }),
        );
      return {
        terminal: await client.createTerminal({
          kind: 'telnet',
          bookmarkId: tab.bookmarkId,
          ...(tab.profileId ? { profileId: tab.profileId } : {}),
          cols: 160,
          rows: 80,
        }),
        connectionId: undefined,
      };
    }

    if (tab.kind === 'serial') {
      if (!tab.bookmarkId) throw new LocalShellError(xRef.current('app.serialBookmarkReopen'));
      return {
        terminal: await client.createTerminal({
          kind: 'serial',
          bookmarkId: tab.bookmarkId,
          ...(tab.profileId ? { profileId: tab.profileId } : {}),
          cols: 160,
          rows: 80,
        }),
        connectionId: undefined,
      };
    }

    if (preferredConnectionId)
      return {
        terminal: await client.createTerminal({
          kind: 'ssh',
          connectionId: preferredConnectionId,
          ...(tab.bookmarkId ? { bookmarkId: tab.bookmarkId } : {}),
          ...(tab.profileId ? { profileId: tab.profileId } : {}),
          cols: 160,
          rows: 80,
        }),
        connectionId: preferredConnectionId,
      };

    const liveConnections = await client.connections();
    let connection = liveConnections.find(
      (item) => item.id === tab.connectionId && item.state === 'ready',
    );
    if (!connection && tab.hostId) {
      connection = liveConnections.find(
        (item) =>
          item.hostId === tab.hostId &&
          (item.connectionProfileId ?? undefined) === tab.connectionProfileId &&
          item.state === 'ready',
      );
      if (!connection) {
        const connectionProfileId =
          tab.connectionProfileId ??
          bookmarkTree.data?.bookmarks.find((bookmark) => bookmark.hostId === tab.hostId)
            ?.connectionProfileId ??
          undefined;
        const pending = await client.createConnection(
          tab.hostId,
          undefined,
          undefined,
          connectionProfileId,
        );
        connection = await waitForConnection(pending.id);
      }
    }
    if (!connection) throw new LocalShellError(xRef.current('app.sshHostBookmarkReconnect'));
    return {
      terminal: await client.createTerminal({
        kind: 'ssh',
        connectionId: connection.id,
        ...(tab.bookmarkId ? { bookmarkId: tab.bookmarkId } : {}),
        ...(tab.profileId ? { profileId: tab.profileId } : {}),
        cols: 160,
        rows: 80,
      }),
      connectionId: connection.id,
    };
  }

  async function retryTerminalConnection(tab: TerminalTab) {
    const latestConnections = connections.data ?? (await client.connections());
    const current = connectionForReconnect(tab, latestConnections);
    if (!current) {
      setTerminalError(xRef.current('app.sshRetryUnavailable'));
      return;
    }
    if (retryingConnectionIdsRef.current.has(current.id)) return;

    const expectedGeneration = generation.current;
    addBounded(retryingConnectionIdsRef.current, current.id);
    setRetryingConnectionIds(new Set(retryingConnectionIdsRef.current));
    setTerminalError('');
    try {
      const replacement = await client.retryConnection(current.id);
      const readyConnection = await waitForConnection(replacement.id, expectedGeneration);
      if (appDisposed.current || generation.current !== expectedGeneration) return;

      const matchingTabs = useWorkspace
        .getState()
        .tabs.filter(
          (candidate) =>
            candidate.kind === 'ssh' &&
            (candidate.connectionId === current.id || candidate.id === tab.id),
        );
      for (const candidate of matchingTabs) {
        if (appDisposed.current || generation.current !== expectedGeneration) break;
        await reloadTab(candidate.id, readyConnection.id, expectedGeneration);
      }
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (error) {
      if (!appDisposed.current && generation.current === expectedGeneration)
        setTerminalError(shellErrorMessage(error, xRef.current('app.retrySshError')));
    } finally {
      retryingConnectionIdsRef.current.delete(current.id);
      if (!appDisposed.current) setRetryingConnectionIds(new Set(retryingConnectionIdsRef.current));
    }
  }

  async function cancelTerminalConnectionReconnect(tab: TerminalTab) {
    const latestConnections = connections.data ?? (await client.connections());
    const current = connectionForReconnect(tab, latestConnections);
    if (!current || current.state !== 'reconnecting') return;
    if (cancelingConnectionIdsRef.current.has(current.id)) return;

    addBounded(cancelingConnectionIdsRef.current, current.id);
    setCancelingConnectionIds(new Set(cancelingConnectionIdsRef.current));
    setTerminalError('');
    try {
      await client.cancelConnectionReconnect(current.id);
      await queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (error) {
      if (!appDisposed.current)
        setTerminalError(shellErrorMessage(error, xRef.current('app.cancelReconnectError')));
    } finally {
      cancelingConnectionIdsRef.current.delete(current.id);
      if (!appDisposed.current)
        setCancelingConnectionIds(new Set(cancelingConnectionIdsRef.current));
    }
  }

  useEffect(() => {
    const currentGeneration = status.data?.metadata.generation;
    const snapshot = connections.data;
    if (!currentGeneration || !snapshot) return;

    for (const connection of snapshot) {
      if (reconnectTransitions.current.observe(currentGeneration, connection))
        addBounded(pendingRecoveredConnections.current, connection.id);
    }

    for (const connection of snapshot) {
      if (connection.state !== 'ready' || !pendingRecoveredConnections.current.has(connection.id))
        continue;
      pendingRecoveredConnections.current.delete(connection.id);
      if (activeConnectionReloads.current.has(connection.id)) continue;

      const recoveredTabs = useWorkspace
        .getState()
        .tabs.filter((tab) => tab.kind === 'ssh' && tab.connectionId === connection.id);
      if (!recoveredTabs.length) continue;
      addBounded(activeConnectionReloads.current, connection.id);

      void (async () => {
        try {
          for (const recoveredTab of recoveredTabs) {
            if (appDisposed.current || generation.current !== currentGeneration) break;
            const currentTab = useWorkspace
              .getState()
              .tabs.find((tab) => tab.id === recoveredTab.id);
            if (!currentTab || currentTab.connectionId !== connection.id) continue;

            const terminal = await client.createTerminal({
              kind: 'ssh',
              connectionId: connection.id,
              ...(currentTab.bookmarkId ? { bookmarkId: currentTab.bookmarkId } : {}),
              ...(currentTab.profileId ? { profileId: currentTab.profileId } : {}),
              cols: 160,
              rows: 80,
            });
            if (appDisposed.current || generation.current !== currentGeneration) {
              await client.closeTerminal(terminal.id).catch(() => {});
              break;
            }
            const stillCurrent = useWorkspace
              .getState()
              .tabs.find((tab) => tab.id === recoveredTab.id);
            if (!stillCurrent || stillCurrent.connectionId !== connection.id) {
              await client.closeTerminal(terminal.id).catch(() => {});
              continue;
            }
            const reloadState = captureTerminalReloadState(stillCurrent);
            terminalReloadStates.current.set(terminal.id, reloadState);
            replaceTerminal(recoveredTab.id, {
              ...stillCurrent,
              id: terminal.id,
              connectionId: connection.id,
              ...(terminal.profileId ? { profileId: terminal.profileId } : {}),
              appearance: terminal.appearance,
              behavior: terminal.behavior,
              disconnected: false,
            });
            await client.closeTerminal(recoveredTab.id).catch(() => {});
          }
        } catch (error) {
          if (!appDisposed.current && generation.current === currentGeneration)
            setTerminalError(
              shellErrorMessage(error, xRef.current('app.rebuildRecoveredSshError')),
            );
        } finally {
          activeConnectionReloads.current.delete(connection.id);
        }
      })();
    }
  }, [
    captureTerminalReloadState,
    client,
    connections.data,
    replaceTerminal,
    status.data?.metadata.generation,
  ]);

  async function cloneTabToNextPane(id: string) {
    const terminalId = await duplicateTab(id);
    if (!terminalId) return;
    const count = paneCount(layoutMode);
    if (count === 1) {
      setLayoutMode('c2');
      setPaneTerminal(1, terminalId);
      return;
    }
    setPaneTerminal((focusedPane + 1) % count, terminalId);
  }

  async function reloadTabs(ids: string[]) {
    for (const id of ids) await reloadTab(id);
  }

  async function closeTab(id: string) {
    const tab = useWorkspace.getState().tabs.find((item) => item.id === id);
    terminalReloadStates.current.delete(id);
    terminalViews.current.delete(id);
    closeTerminal(id);
    await (
      tab?.kind === 'rdp'
        ? client.closeRdpSession(id)
        : tab?.kind === 'vnc'
          ? client.closeVncSession(id)
          : tab?.kind === 'spice'
            ? client.closeSpiceSession(id)
            : tab?.kind === 'web'
              ? client.closeWebSession(id)
              : client.closeTerminal(id)
    ).catch(() => {});
  }

  async function closeTabs(ids: string[]) {
    // Pins change display order only. Explicit close-other/right/all actions
    // still close pinned entries in the selected pane batch.
    for (const id of ids) {
      terminalReloadStates.current.delete(id);
      terminalViews.current.delete(id);
      closeTerminal(id);
    }
    const closing = new Map(tabs.map((tab) => [tab.id, tab.kind]));
    await Promise.allSettled(
      ids.map((id) =>
        closing.get(id) === 'rdp'
          ? client.closeRdpSession(id)
          : closing.get(id) === 'vnc'
            ? client.closeVncSession(id)
            : closing.get(id) === 'spice'
              ? client.closeSpiceSession(id)
              : closing.get(id) === 'web'
                ? client.closeWebSession(id)
                : client.closeTerminal(id),
      ),
    );
  }

  function currentLayout() {
    return {
      section,
      contentSurface,
      sidebarOpen,
      split,
      tabs: tabs.map(({ disconnected: _disconnected, ...tab }) => ({
        ...tab,
        pinned: tab.pinned ?? false,
        paneIndex: tab.paneIndex ?? 0,
      })),
      activeTerminalId: activeTerminalId ?? null,
      secondaryTerminalId: secondaryTerminalId ?? null,
      layoutMode,
      paneTerminalIds,
      focusedPane,
    };
  }

  async function saveWorkspace(name: string): Promise<boolean> {
    setTerminalError('');
    try {
      if (!settings.data) return false;
      const now = new Date().toISOString();
      const existing = settings.data.workspace.namedWorkspaces.find(
        (item) => item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0,
      );
      if (existing && !window.confirm(xRef.current('app.overwriteWorkspaceConfirm', { name })))
        return false;
      const workspace: NamedWorkspace = {
        id: existing?.id ?? crypto.randomUUID(),
        name,
        layout: currentLayout(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const namedWorkspaces = existing
        ? settings.data.workspace.namedWorkspaces.map((item) =>
            item.id === existing.id ? workspace : item,
          )
        : [...settings.data.workspace.namedWorkspaces, workspace];
      const value = await client.updateSettings(settings.data, {
        workspace: {
          namedWorkspaces,
          activeWorkspaceId: workspace.id,
        },
      });
      queryClient.setQueryData(['settings'], value);
      return true;
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.saveWorkspaceError')));
      return false;
    }
  }

  async function loadWorkspace(workspace: NamedWorkspace) {
    if (!settings.data) return;
    setTerminalError('');
    try {
      const targetIds = new Set(workspace.layout.tabs.map(({ id }) => id));
      const [liveTerminals, liveRdp, liveVnc, liveSpice, liveWeb] = await Promise.all([
        client.terminals(),
        client.rdpSessions(),
        client.vncSessions(),
        client.spiceSessions(),
        client.webSessions(),
      ]);
      const obsoleteTerminalIds = liveTerminals
        .filter(({ id }) => !targetIds.has(id))
        .map(({ id }) => id);
      const obsoleteRdpIds = liveRdp.filter(({ id }) => !targetIds.has(id)).map(({ id }) => id);
      const obsoleteVncIds = liveVnc.filter(({ id }) => !targetIds.has(id)).map(({ id }) => id);
      const obsoleteSpiceIds = liveSpice.filter(({ id }) => !targetIds.has(id)).map(({ id }) => id);
      const obsoleteWebIds = liveWeb.filter(({ id }) => !targetIds.has(id)).map(({ id }) => id);
      const closed = await Promise.allSettled([
        ...obsoleteTerminalIds.map((id) => client.closeTerminal(id)),
        ...obsoleteRdpIds.map((id) => client.closeRdpSession(id)),
        ...obsoleteVncIds.map((id) => client.closeVncSession(id)),
        ...obsoleteSpiceIds.map((id) => client.closeSpiceSession(id)),
        ...obsoleteWebIds.map((id) => client.closeWebSession(id)),
      ]);
      if (closed.some((result) => result.status === 'rejected'))
        throw new LocalShellError(xRef.current('app.releaseWorkspaceSessionsError'));
      const [remainingTerminals, remainingRdp, remainingVnc, remainingSpice, remainingWeb] =
        await Promise.all([
          client.terminals(),
          client.rdpSessions(),
          client.vncSessions(),
          client.spiceSessions(),
          client.webSessions(),
        ]);
      const liveAfter = new Set(
        [
          ...remainingTerminals,
          ...remainingRdp,
          ...remainingVnc,
          ...remainingSpice,
          ...remainingWeb,
        ].map(({ id }) => id),
      );
      restoreLayout(workspace.layout, liveAfter);
      for (const tab of workspace.layout.tabs)
        if (!liveAfter.has(tab.id)) await reloadTab(tab.id, undefined, generation.current);
      const value = await client.updateSettings(settings.data, {
        workspace: { activeWorkspaceId: workspace.id },
      });
      queryClient.setQueryData(['settings'], value);
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.loadWorkspaceError')));
    }
  }

  useLayoutEffect(() => {
    startupBookmarkConnector.current = connectBookmark;
    startupWorkspaceLoader.current = loadWorkspace;
  });

  async function deleteWorkspace(workspace: NamedWorkspace) {
    if (
      !settings.data ||
      !window.confirm(xRef.current('app.deleteWorkspaceConfirm', { name: workspace.name }))
    )
      return;
    try {
      const value = await client.updateSettings(settings.data, {
        workspace: {
          namedWorkspaces: settings.data.workspace.namedWorkspaces.filter(
            (item) => item.id !== workspace.id,
          ),
          activeWorkspaceId:
            settings.data.workspace.activeWorkspaceId === workspace.id
              ? null
              : settings.data.workspace.activeWorkspaceId,
        },
      });
      queryClient.setQueryData(['settings'], value);
    } catch (error) {
      setTerminalError(shellErrorMessage(error, xRef.current('app.deleteWorkspaceError')));
    }
  }

  function finishRename(id: string, title: string) {
    renameTerminal(id, title);
    setRenamingTabId(undefined);
  }

  function handleTabWheel(event: React.WheelEvent<HTMLDivElement>) {
    const element = tabbar.current;
    if (!element || element.scrollWidth <= element.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    element.scrollLeft += event.deltaY;
  }

  function scrollTabs(direction: -1 | 1) {
    tabbar.current?.scrollBy({ left: direction * 180, behavior: 'smooth' });
  }

  function reconnect() {
    client.reconnect();
    void queryClient.resetQueries({ queryKey: statusKey });
  }

  function activateNavigation(next: WorkspaceSection) {
    const workspace = useWorkspace.getState();
    if (workspace.section === next && workspace.sidebarOpen && !workspace.aiInspectorOpen) {
      toggleSidebar();
      return;
    }
    setSection(next);
    if (!workspace.sidebarOpen) toggleSidebar();
  }

  function openSettingsDestination(
    tab: 'setting' | 'themes' | 'profiles' | 'widgets',
    item: 'terminal' | 'common' | 'sync' = 'common',
  ) {
    setSettingsDestination((current) => ({ tab, item, nonce: current.nonce + 1 }));
    showSection('settings');
    if (!useWorkspace.getState().sidebarOpen) toggleSidebar();
  }

  function activateActivityItem(item: VisibleActivityRailItem) {
    if (item === 'newBookmark') {
      openNewBookmark();
      return;
    }
    if (item === 'bookmarks') {
      activateNavigation('hosts');
      return;
    }
    openSettingsDestination('setting', 'common');
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        (event.target instanceof Element && event.target.closest('[data-shortcut-capture="true"]'))
      )
        return;
      const primaryModifier = platform === 'mac' ? event.metaKey : event.ctrlKey;
      if (primaryModifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          const open = !useWorkspace.getState().paletteOpen;
          if (open && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
          if (open)
            setPaletteContext({
              terminalId: useWorkspace.getState().activeTerminalId,
              value: shortcutContext(),
            });
          setPalette(open);
        }
        return;
      }
      if (useWorkspace.getState().paletteOpen) return;
      if (primaryModifier && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleSidebar();
      }
      if (event.key === 'Escape') {
        setTabMenu(undefined);
        setNewSessionMenuOpen(false);
        setLayoutMenuOpen(false);
        setTabOverflowMenuOpen(false);
        setTransferCenterOpen(false);
      }
      if (event.defaultPrevented || event.repeat || isShortcutInputTarget(event.target)) return;
      const chord = shortcutFromKeyboardEvent(event);
      if (!chord) return;
      const action = shortcutActionForChord(chord, settings.data?.shortcuts.bindings, platform);
      if (!action) return;
      if (
        action.scope === 'terminal' &&
        !(event.target instanceof Element && event.target.closest('.xterm'))
      )
        return;
      if (!runShortcutAction(action.id)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const wheel = (event: WheelEvent) => {
      if (
        !(event.target instanceof Element && event.target.closest('.xterm')) ||
        isShortcutInputTarget(event.target)
      )
        return;
      const chord = shortcutFromWheelEvent(event);
      if (!chord) return;
      const action = shortcutActionForChord(chord, settings.data?.shortcuts.bindings, platform);
      if (!action || action.scope !== 'terminal' || !runShortcutAction(action.id)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', listener, true);
    window.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', listener, true);
      window.removeEventListener('wheel', wheel);
    };
  });

  const currentTab = tabs.find((tab) => tab.id === activeTerminalId);
  const hoveredWorkspaceTab = tabs.find((tab) => tab.id === hoveredWorkspaceTabId);
  const workspaceCloseTab =
    hoveredWorkspaceTabId && hoveredWorkspaceTab ? hoveredWorkspaceTab : currentTab;
  const terminalSurfaceActive = contentSurface === 'terminal' && !!currentTab;
  useEffect(() => {
    if (!terminalSurfaceActive) return;
    const workspace = workspaceMain.current;
    const controls = windowControlBar.current;
    if (!workspace || !controls) return;
    const update = () => {
      workspace.style.setProperty(
        '--terminal-window-controls-width',
        `${Math.ceil(controls.getBoundingClientRect().width)}px`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(controls);
    update();
    return () => {
      observer.disconnect();
      workspace.style.removeProperty('--terminal-window-controls-width');
    };
  }, [terminalSurfaceActive]);
  const currentSessionMode =
    currentTab && terminalSessionModes[currentTab.id] === 'files' ? 'files' : 'terminal';
  const terminalContentActive = terminalSurfaceActive && currentSessionMode === 'terminal';
  const remoteMonitorVisible =
    terminalContentActive &&
    currentTab?.kind === 'ssh' &&
    !terminalInformationOpen &&
    !aiInspectorOpen &&
    (settings.data?.monitor.remoteMonitorBarEnabled ?? false);
  const contextTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.id) : undefined;
  const contextBatchTabs = contextTab ? paneTabsInDisplayOrder(tabs, paneOf(contextTab)) : [];
  const activeNavigationItem = navigation.find(({ id }) => id === section);
  const SectionIcon = activeNavigationItem?.icon ?? Activity;
  const activeSectionLabel = activeNavigationItem
    ? x(activeNavigationItem.messageKey)
    : x('app.workspaceHeading');
  const workspaceHeading =
    terminalSurfaceActive && currentTab ? currentTab.title : activeSectionLabel;
  const activeTransfers =
    transfers.data?.filter((transfer) =>
      ['queued', 'preparing', 'running', 'awaiting-decision'].includes(transfer.state),
    ) ?? [];

  return (
    <div
      ref={shellRoot}
      className={`app-shell section-${section} surface-${contentSurface} ${isMac ? 'is-mac' : ''} ${isWindows ? 'is-windows' : ''} ${sidebarOpen ? '' : 'sidebar-collapsed'} ${aiInspectorOpen ? 'with-ai' : ''} ${terminalInformationOpen && !aiInspectorOpen ? 'with-terminal-information' : ''}`}
    >
      {terminalSurfaceActive && <div className="workspace-left-rail" aria-hidden="true" />}
      <aside
        ref={activityRail}
        className="app-sidebar activity-bar"
        aria-label={x('app.primaryFeatures')}
      >
        <div className="activity-brand" />
        <Tooltip.Provider delay={250}>
          <nav aria-label={x('app.primaryFeatures')}>
            <ActivityRailButton
              active={aiInspectorOpen}
              item="ai"
              expanded={aiInspectorOpen}
              label={x('panels.aiInspector')}
              portalContainer={activityRail}
              onClick={() => {
                setTerminalInformationOpen(false);
                toggleAiInspector();
              }}
            >
              <Bot size={19} strokeWidth={1.65} />
            </ActivityRailButton>
            {orderedActivityRailItems(settings.data).map((item) => {
              const definition = activityRailDefinitions[item];
              const Icon = definition.icon;
              const label = t(definition.translationKey, definition.fallback);
              const active =
                (item === 'bookmarks' && section === 'hosts' && sidebarOpen && !aiInspectorOpen) ||
                (item === 'setting' && section === 'settings');
              return (
                <ActivityRailButton
                  key={item}
                  active={active}
                  item={item}
                  label={label}
                  portalContainer={activityRail}
                  onClick={() => activateActivityItem(item)}
                >
                  <Icon size={19} strokeWidth={1.65} />
                </ActivityRailButton>
              );
            })}
          </nav>
        </Tooltip.Provider>
        <div className="activity-bottom">
          <span className={`activity-runtime ${ready ? 'ready' : status.isError ? 'error' : ''}`} />
        </div>
      </aside>

      {newSessionMenuOpen && (
        <NewSessionMenu
          hosts={hosts.data ?? []}
          hideAddresses={settings.data?.privacy.hideAddresses ?? false}
          profiles={terminalProfiles.data ?? []}
          defaultProfileId={settings.data?.terminal.defaultProfileId}
          onLocal={(profileId) => void createLocalTerminal(profileId)}
          onHost={(host, profileId) => {
            const bookmark = bookmarkTree.data?.bookmarks.find(
              (candidate) => candidate.hostId === host.id,
            );
            void openHostTerminal(
              host,
              undefined,
              profileId ?? bookmark?.profileId ?? undefined,
              bookmark?.connectionProfileId ?? undefined,
              bookmark?.id,
            );
          }}
          onQuickConnect={(target, profileId) => void quickConnect(target, profileId)}
          onNewBookmark={openNewBookmark}
          onOpenBookmarks={() => activateNavigation('hosts')}
          onDismiss={() => setNewSessionMenuOpen(false)}
        />
      )}

      <WorkspaceSidebar
        section={section}
        aiPanel={
          aiInspectorOpen ? (
            <AiPanel
              client={client}
              activeTerminalId={activeTerminalId}
              embedded
              workspaceTitle={currentTab?.title ?? x('app.noTerminalSelected')}
              requestedDraft={terminalAiDraft}
              onDraftConsumed={() => setTerminalAiDraft(undefined)}
            />
          ) : undefined
        }
        sectionPanel={
          <>
            {section === 'hosts' && bookmarkManagerOpen && (
              <>
                <button
                  className="bookmark-manager-back"
                  onClick={() => setBookmarkManagerOpen(false)}
                >
                  <ChevronLeft size={13} /> {x('app.bookmarks')}
                </button>
                <div ref={setHostManagerContainer} />
              </>
            )}
            {section === 'files' && currentSessionMode !== 'files' && (
              <FilesPanel
                active={sidebarOpen && !aiInspectorOpen}
                key={`${initialFileDirectoryGrantId ?? 'files'}:${requestedSftpDirectory?.nonce ?? ''}`}
                client={client}
                {...(initialFileDirectoryGrantId
                  ? { initialLocalDirectoryGrantId: initialFileDirectoryGrantId }
                  : {})}
                queryClient={queryClient}
                hosts={hosts.data ?? []}
                connections={connections.data ?? []}
                ftpConnections={ftpConnections.data ?? []}
                transfers={transfers.data ?? []}
                settings={settings.data}
                requestedSshDirectory={requestedSftpDirectory}
                getActiveSshDirectory={() => {
                  const workspace = useWorkspace.getState();
                  const active = workspace.tabs.find(({ id }) => id === workspace.activeTerminalId);
                  if (active?.kind !== 'ssh' || !active.connectionId) return undefined;
                  const cwd = terminalViews.current.get(active.id)?.getCwd();
                  return cwd?.startsWith('/')
                    ? { connectionId: active.connectionId, path: cwd }
                    : undefined;
                }}
              />
            )}
            {section === 'tunnels' && (
              <TunnelsPanel
                client={client}
                connections={connections.data ?? []}
                hosts={hosts.data ?? []}
              />
            )}
            {section === 'commands' && (
              <CommandsPanel client={client} requestedSection={commandWorkspaceSection} />
            )}
          </>
        }
        hostManagerOpen={bookmarkManagerOpen}
        hostPanelTab={hostSidebarTab}
        onHostPanelTabChange={setHostSidebarTab}
        onOpenHostManager={openBookmarkManager}
        bookmarkTree={bookmarkTree.data}
        bookmarkBusy={bookmarkBusy || bookmarkTree.isLoading}
        hosts={hosts.data ?? []}
        connections={connections.data ?? []}
        tabs={tabs}
        activeTerminalId={activeTerminalId}
        ready={ready}
        runtimeError={status.isError}
        onCollapse={toggleSidebar}
        onConnectBookmark={connectBookmark}
        onEditBookmark={editBookmark}
        onDuplicateBookmark={(bookmark) => void duplicateBookmark(bookmark)}
        onDeleteBookmark={(bookmark) => void deleteBookmark(bookmark)}
        onCreateBookmarkGroup={createBookmarkGroup}
        onRenameBookmarkGroup={renameBookmarkGroup}
        onDeleteBookmarkGroup={deleteBookmarkGroup}
        onMoveBookmark={moveBookmarkTreeNode}
        onImportSshConfig={() => void openSshConfigImport()}
        onSelectSection={showSection}
        onOpenFiles={(connectionId) => void openFilesInSession(connectionId)}
        onSelectTerminal={setActiveTerminal}
        onCloseTerminal={(id) => void closeTab(id)}
        onCreateTerminal={() => void createLocalTerminal()}
        historyPanel={
          <ConnectionHistorySidebar
            client={client}
            queryClient={queryClient}
            ready={ready}
            bookmarkTree={bookmarkTree.data}
            settings={settings.data}
            onReconnect={openHistoryTerminal}
          />
        }
      />

      <HostsPanel
        managerContainer={hostManagerContainer}
        managerActive={
          sidebarOpen &&
          !aiInspectorOpen &&
          section === 'hosts' &&
          hostSidebarTab === 'bookmarks' &&
          bookmarkManagerOpen
        }
        client={client}
        queryClient={queryClient}
        hosts={hosts.data ?? []}
        bookmarkTree={bookmarkTree.data}
        connections={connections.data ?? []}
        hideAddresses={settings.data?.privacy.hideAddresses ?? false}
        onCreateBookmarkGroup={() => createBookmarkGroup(null)}
        onConnectBookmark={connectBookmark}
        onDuplicateBookmark={(bookmark) => void duplicateBookmark(bookmark)}
        onDeleteBookmark={(bookmark) => void deleteBookmark(bookmark)}
        {...(bookmarkEditId ? { requestedBookmarkId: bookmarkEditId } : {})}
        requestedCreate={bookmarkCreateRequested}
        {...(requestedQuickConnect ? { requestedQuickConnect } : {})}
        onRequestedBookmarkHandled={() => {
          setBookmarkEditId(undefined);
          setBookmarkCreateRequested(false);
          setRequestedQuickConnect(undefined);
          window.queueMicrotask(() => void deepLinkDrain.current());
        }}
      />

      <main
        ref={workspaceMain}
        aria-labelledby="workspace-main-heading"
        className={`${terminalSurfaceActive ? 'workspace-main terminal-workspace' : 'workspace-main'} ${remoteMonitorVisible ? 'with-remote-monitor' : ''}`}
      >
        {terminalSurfaceActive || section !== 'settings' ? (
          <h1 id="workspace-main-heading" className="sr-only">
            {workspaceHeading}
          </h1>
        ) : null}
        <div className="tabbar" ref={windowControlBar}>
          <div
            className="tabbar-scroll"
            ref={tabbar}
            onMouseMove={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('.tab-close-active')) return;
              setHoveredWorkspaceTabId(
                target.closest<HTMLElement>('.terminal-tab')?.dataset.terminalId,
              );
            }}
            onMouseLeave={() => setHoveredWorkspaceTabId(undefined)}
            onWheel={handleTabWheel}
          >
            {!terminalSurfaceActive && section === 'settings' && (
              <h1 id="workspace-main-heading" className="workspace-tab active section-tab">
                <SectionIcon size={14} aria-hidden="true" />
                <span>{activeSectionLabel}</span>
              </h1>
            )}
            {!terminalSurfaceActive && (
              <div
                className="workspace-session-tabs"
                role="tablist"
                aria-label={x('shell.allTabs')}
              >
                {tabs.map((tab) => (
                  <div className="workspace-tab-entry" key={tab.id} role="presentation">
                    <div
                      className={`workspace-tab terminal-tab ${activeTerminalId === tab.id ? 'active' : ''} ${workspaceCloseTab?.id === tab.id ? 'close-target' : ''} ${tab.disconnected ? 'disconnected' : ''} ${tab.pinned ? 'pinned' : ''}`}
                      data-terminal-id={tab.id}
                      role="tab"
                      tabIndex={activeTerminalId === tab.id ? 0 : -1}
                      draggable
                      aria-selected={activeTerminalId === tab.id}
                      onClick={() => setActiveTerminal(tab.id)}
                      onMouseEnter={() => {
                        if (
                          (settings.data?.workspace.switchTabOnHover ?? false) &&
                          activeTerminalId !== tab.id &&
                          !document.querySelector('.terminal-tab.dragging')
                        )
                          setActiveTerminal(tab.id);
                      }}
                      onDoubleClick={() => void duplicateTab(tab.id)}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        void closeTab(tab.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setActiveTerminal(tab.id);
                        setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY });
                      }}
                      onDragStart={(event) => {
                        event.currentTarget.classList.add('dragging');
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-axterm-tab', tab.id);
                      }}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes('application/x-axterm-tab')) return;
                        event.preventDefault();
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
                        const bounds = event.currentTarget.getBoundingClientRect();
                        moveTerminal(
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
                        tabbar.current
                          ?.querySelectorAll('.drop-before, .drop-after')
                          .forEach((element) =>
                            element.classList.remove('drop-before', 'drop-after'),
                          );
                      }}
                      onKeyDown={(event) => {
                        const direction =
                          event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
                        const index = tabs.findIndex((candidate) => candidate.id === tab.id);
                        const targetIndex = direction
                          ? (index + direction + tabs.length) % tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : -1;
                        const target = tabs[targetIndex];
                        if (target) {
                          event.preventDefault();
                          setActiveTerminal(target.id);
                          tabbar.current
                            ?.querySelectorAll<HTMLElement>('[role="tab"]')
                            .forEach((element) => {
                              if (element.dataset.terminalId === target.id) element.focus();
                            });
                        } else if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setActiveTerminal(tab.id);
                        }
                      }}
                    >
                      <GripVertical className="tab-grip" size={12} />
                      <span className="tab-state" />
                      {(settings.data?.workspace.showTabNumber ?? true) && (
                        <span className="tab-number">{tab.tabNumber}</span>
                      )}
                      <Terminal size={14} />
                      {tab.pinned && <Pin className="tab-pin" size={10} fill="currentColor" />}
                      {renamingTabId === tab.id ? (
                        <input
                          className="tab-rename"
                          autoFocus
                          defaultValue={tab.title}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={(event) => finishRename(tab.id, event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Enter') event.currentTarget.blur();
                            if (event.key === 'Escape') setRenamingTabId(undefined);
                          }}
                        />
                      ) : (
                        <span className="tab-title">{tab.title}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!terminalSurfaceActive && workspaceCloseTab && !workspaceCloseTab.pinned && (
              <button
                className="tab-close-active"
                aria-label={x('shell.closeTab', { title: workspaceCloseTab.title })}
                title={x('shell.closeTab', { title: workspaceCloseTab.title })}
                onClick={() => {
                  setHoveredWorkspaceTabId(undefined);
                  void closeTab(workspaceCloseTab.id);
                }}
              >
                <X size={14} />
              </button>
            )}
            {!terminalSurfaceActive && (
              <button
                className="tab-add"
                onClick={() => void createLocalTerminal()}
                title={x('app.newLocalTerminal')}
              >
                <Plus size={15} />
              </button>
            )}
            {!terminalSurfaceActive && (
              <button
                className={newSessionMenuOpen ? 'tab-add-menu active' : 'tab-add-menu'}
                onClick={() => {
                  setNewSessionMenuOpen((open) => !open);
                  setLayoutMenuOpen(false);
                  setTabOverflowMenuOpen(false);
                }}
                title={x('app.newSessionMenu')}
              >
                <ChevronDown size={11} />
              </button>
            )}
          </div>
          <div className="tabbar-actions">
            {tabOverflow && (
              <>
                <button onClick={() => scrollTabs(-1)} title={x('app.scrollTabsLeft')}>
                  <ChevronLeft size={13} />
                </button>
                <button onClick={() => scrollTabs(1)} title={x('app.scrollTabsRight')}>
                  <ChevronRight size={13} />
                </button>
                <button
                  className={tabOverflowMenuOpen ? 'active' : ''}
                  onClick={() => {
                    setTabOverflowMenuOpen((open) => !open);
                    setLayoutMenuOpen(false);
                    setNewSessionMenuOpen(false);
                  }}
                  title={x('shell.allTabs')}
                >
                  <ChevronDown size={13} />
                </button>
              </>
            )}
            <button
              onClick={() => {
                setLayoutMenuOpen((open) => !open);
                setNewSessionMenuOpen(false);
                setTabOverflowMenuOpen(false);
              }}
              className={split ? 'active' : ''}
              disabled={!tabs.length}
              title={x('app.layoutWorkspace')}
            >
              <LayoutGrid size={14} />
            </button>
            <button onClick={reconnect} aria-label={x('app.reconnect')} title={x('app.reconnect')}>
              <RefreshCw size={14} />
            </button>
            <button
              onClick={toggleDetails}
              aria-label={x('app.connectionDetails')}
              title={x('app.connectionDetails')}
            >
              <Activity size={14} />
            </button>
            <button
              onClick={(event) => {
                if (!activeTerminalId) return;
                const box = event.currentTarget.getBoundingClientRect();
                setTabMenu({ id: activeTerminalId, x: box.right - 190, y: box.bottom + 4 });
              }}
              disabled={!activeTerminalId}
              title={x('app.tabActions')}
            >
              <Ellipsis size={15} />
            </button>
          </div>
          {layoutMenuOpen && (
            <LayoutWorkspaceMenu
              layout={layoutMode}
              workspaces={settings.data?.workspace.namedWorkspaces ?? []}
              activeWorkspaceId={settings.data?.workspace.activeWorkspaceId ?? null}
              onLayout={setLayoutMode}
              onSave={saveWorkspace}
              onLoad={(workspace) => void loadWorkspace(workspace)}
              onDelete={(workspace) => void deleteWorkspace(workspace)}
              onDismiss={() => setLayoutMenuOpen(false)}
            />
          )}
          {tabOverflowMenuOpen && (
            <TabOverflowMenu
              tabs={tabs}
              activeTerminalId={activeTerminalId}
              onSelect={setActiveTerminal}
              onDismiss={() => setTabOverflowMenuOpen(false)}
            />
          )}
          <WindowControls client={client} openTabCount={tabs.length} />
        </div>

        {recoveryNotice && (
          <div
            className={`session-recovery-banner ${recoveryNotice.kind}`}
            data-testid="session-recovery"
            data-recovery-kind={recoveryNotice.kind}
            role={recoveryNotice.kind === 'offline' ? 'alert' : 'status'}
            aria-live="polite"
          >
            <span className="session-recovery-icon" aria-hidden="true">
              {recoveryNotice.kind === 'offline' ? (
                <WifiOff size={16} />
              ) : recoveryNotice.kind === 'runtime-restarted' ? (
                <RotateCcw size={16} />
              ) : (
                <CheckCircle2 size={16} />
              )}
            </span>
            <span className="session-recovery-copy">
              <strong>{x(`app.recovery.${recoveryNotice.kind}.title`)}</strong>
              <small>{x(`app.recovery.${recoveryNotice.kind}.message`)}</small>
            </span>
            <span className="session-recovery-actions">
              <button
                type="button"
                onClick={() => {
                  reconnect();
                  void queryClient.invalidateQueries();
                }}
              >
                <RefreshCw size={12} />
                {x('app.refreshState')}
              </button>
              {recoveryNotice.kind !== 'offline' && (
                <button
                  type="button"
                  className="icon"
                  aria-label={x('app.dismissRecovery')}
                  title={x('app.dismissRecovery')}
                  onClick={() => setRecoveryNotice(undefined)}
                >
                  <X size={13} />
                </button>
              )}
            </span>
          </div>
        )}

        <div className="workspace-content">
          {!ready ? (
            <div className="runtime-wait">
              <RefreshCw className={status.isFetching ? 'spin' : ''} size={24} />
              <h2>{status.isError ? x('app.runtimeDegraded') : x('app.runtimeConnecting')}</h2>
              <p>{x('app.runtimeUnavailable')}</p>
              <button onClick={reconnect}>{x('app.reconnect')}</button>
            </div>
          ) : (
            <>
              {!!tabs.length && (
                <div className="terminal-workspace-layer" hidden={!terminalSurfaceActive}>
                  <TerminalPaneGrid
                    profiles={terminalProfiles.data ?? []}
                    client={client}
                    layout={layoutMode}
                    paneTerminalIds={paneTerminalIds}
                    focusedPane={focusedPane}
                    tabs={tabs}
                    connections={connections.data ?? []}
                    retryingConnectionIds={retryingConnectionIds}
                    cancelingConnectionIds={cancelingConnectionIds}
                    onFocus={focusPane}
                    onSelect={setPaneTerminal}
                    onSwap={swapPanes}
                    terminalSessionModes={terminalSessionModes}
                    onSetTerminalSessionMode={setTerminalSessionMode}
                    renderFileManager={(tab, active) => {
                      const requestedDirectory =
                        tab.kind === 'ssh' &&
                        requestedSftpDirectory?.connectionId === tab.connectionId
                          ? requestedSftpDirectory
                          : undefined;
                      return (
                        <FilesPanel
                          key={`${tab.id}:${requestedDirectory?.nonce ?? ''}`}
                          client={client}
                          session={
                            tab.kind === 'ssh'
                              ? { kind: 'ssh', connectionId: tab.connectionId ?? '' }
                              : { kind: 'local' }
                          }
                          active={active}
                          queryClient={queryClient}
                          hosts={hosts.data ?? []}
                          connections={connections.data ?? []}
                          ftpConnections={ftpConnections.data ?? []}
                          transfers={transfers.data ?? []}
                          settings={settings.data}
                          requestedSshDirectory={requestedDirectory}
                          getActiveSshDirectory={() => {
                            if (tab.kind !== 'ssh' || !tab.connectionId) return undefined;
                            const cwd = terminalViews.current.get(tab.id)?.getCwd();
                            return cwd?.startsWith('/')
                              ? { connectionId: tab.connectionId, path: cwd }
                              : undefined;
                          }}
                        />
                      );
                    }}
                    onNewTerminal={(index) => {
                      focusPane(index);
                      void createLocalTerminal();
                    }}
                    onOpenBookmarks={() => showSection('hosts')}
                    onOpenAi={() => showSection('ai')}
                    onOpenQuickConnect={() => setNewSessionMenuOpen(true)}
                    activeTerminalId={activeTerminalId}
                    renamingTabId={renamingTabId}
                    onActivate={setActiveTerminal}
                    onDuplicate={(id) => void duplicateTab(id)}
                    onFinishRename={finishRename}
                    onContextMenu={(id, x, y) => setTabMenu({ id, x, y })}
                    onMoveTab={moveTerminal}
                    onMoveTabToPane={moveTerminalToPane}
                    onCloseTab={(id) => void closeTab(id)}
                    onOpenSessionMenu={(index) => {
                      focusPane(index);
                      setNewSessionMenuOpen(true);
                    }}
                    onRetryConnection={(tab) => void retryTerminalConnection(tab)}
                    onCancelConnectionReconnect={(tab) =>
                      void cancelTerminalConnectionReconnect(tab)
                    }
                    onReloadRdp={(tab) => void reloadRdpTab(tab)}
                    onReloadVnc={(tab) => void reloadVncTab(tab)}
                    onReloadSpice={(tab) => void reloadSpiceTab(tab)}
                    onReloadWeb={(tab) => void reloadWebTab(tab)}
                    onTerminalViewChange={registerTerminalView}
                    consumeTerminalReloadState={consumeTerminalReloadState}
                    commandHistoryEnabled={settings.data?.privacy.commandHistoryEnabled ?? false}
                    screenReaderMode={settings.data?.terminal.screenReaderMode ?? false}
                    commandSuggestionsEnabled={
                      settings.data?.terminal.commandSuggestionsEnabled ?? false
                    }
                    dragDropBehavior={settings.data?.terminal.dragDropBehavior ?? 'ask'}
                    themes={terminalThemes.data ?? []}
                    globalVisual={settings.data?.terminal.visual}
                    visualPreview={terminalVisualPreview}
                    aiSuggestionsAvailable={!!aiModels.data?.length}
                    onRequestAiSuggestions={requestAiCommandSuggestions}
                    onExplainSelection={explainTerminalSelection}
                    showTabNumber={settings.data?.workspace.showTabNumber ?? true}
                    switchTabOnHover={settings.data?.workspace.switchTabOnHover ?? false}
                    encodingOverrides={terminalEncodingOverrides}
                    onCommandHistoryChanged={() =>
                      void queryClient.invalidateQueries({ queryKey: ['command-history'] })
                    }
                    onTransfersChanged={() =>
                      void queryClient.invalidateQueries({ queryKey: ['transfers'] })
                    }
                  />
                </div>
              )}
              {!terminalSurfaceActive && section !== 'settings' && (
                <NoSessionView
                  onLocal={() => void createLocalTerminal()}
                  onOpenBookmarks={openNewBookmark}
                  onOpenAi={() => showSection('ai')}
                  onQuickConnect={(target) => void quickConnect(target)}
                  historyPanel={
                    <ConnectionHistorySidebar
                      client={client}
                      queryClient={queryClient}
                      ready={ready}
                      bookmarkTree={bookmarkTree.data}
                      settings={settings.data}
                      onReconnect={openHistoryTerminal}
                    />
                  }
                />
              )}
              {!terminalSurfaceActive && section === 'settings' && (
                <RuntimePanel
                  key={`${settingsDestination.tab}:${settingsDestination.item}:${settingsDestination.nonce}`}
                  client={client}
                  initialTab={settingsDestination.tab}
                  initialItem={settingsDestination.item}
                />
              )}
            </>
          )}
          {terminalError && (
            <div className="toast error" role="alert">
              {terminalError}
            </div>
          )}
        </div>
        <RemoteMonitorBar
          client={client}
          visible={remoteMonitorVisible}
          terminal={currentTab}
          items={(settings.data?.monitor.remoteMonitorBarItems ?? []) as RemoteMonitorItem[]}
          onOpenInformation={() => {
            setTerminalInformationOpen(true);
          }}
          onOpenSettings={() => showSection('settings')}
          onDisable={() => void updateMonitorSettings({ remoteMonitorBarEnabled: false })}
        />
      </main>

      <TerminalInformationPanel
        client={client}
        open={terminalInformationOpen && !aiInspectorOpen && terminalContentActive}
        terminal={currentTab}
        selectedItems={
          settings.data?.monitor.terminalInformationItems ?? [...DEFAULT_TERMINAL_INFORMATION_ITEMS]
        }
        onSelectedItemsChange={(items) =>
          void updateMonitorSettings({ terminalInformationItems: items })
        }
        onClose={() => setTerminalInformationOpen(false)}
      />

      {transferCenterOpen && (
        <TransferCenter
          transfers={transfers.data ?? []}
          loadError={transfers.isError}
          onClose={() => setTransferCenterOpen(false)}
          onRetryLoad={() => void transfers.refetch()}
          onCancel={(id) => client.cancelTransfer(id)}
          onRetry={(id) => client.retryTransfer(id)}
          onPause={(id) => client.pauseTransfer(id)}
          onResume={(id) => client.resumeTransfer(id)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ['transfers'] })}
          onClear={() =>
            client
              .clearCompletedTransfers()
              .then(() => queryClient.invalidateQueries({ queryKey: ['transfers'] }))
          }
          onOpenFiles={() => {
            void openFilesInSession();
            setTransferCenterOpen(false);
          }}
        />
      )}

      {tabMenu && (
        <TabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          tab={tabs.find((tab) => tab.id === tabMenu.id)}
          canCloseRight={
            contextBatchTabs.findIndex((tab) => tab.id === tabMenu.id) < contextBatchTabs.length - 1
          }
          onPin={() => {
            pinTerminal(tabMenu.id);
            setTabMenu(undefined);
          }}
          onDuplicate={() => {
            void duplicateTab(tabMenu.id);
            setTabMenu(undefined);
          }}
          onCloneNext={() => {
            void cloneTabToNextPane(tabMenu.id);
            setTabMenu(undefined);
          }}
          onNewTab={() => {
            void createLocalTerminal();
            setTabMenu(undefined);
          }}
          onReload={() => {
            void reloadTab(tabMenu.id);
            setTabMenu(undefined);
          }}
          onReloadAll={() => {
            void reloadTabs(contextBatchTabs.map((tab) => tab.id));
            setTabMenu(undefined);
          }}
          onRename={() => {
            setRenamingTabId(tabMenu.id);
            setTabMenu(undefined);
          }}
          onClose={() => {
            void closeTab(tabMenu.id);
            setTabMenu(undefined);
          }}
          onCloseOthers={() => {
            void closeTabs(
              contextBatchTabs.filter((tab) => tab.id !== tabMenu.id).map((tab) => tab.id),
            );
            setTabMenu(undefined);
          }}
          onCloseRight={() => {
            const index = contextBatchTabs.findIndex((tab) => tab.id === tabMenu.id);
            void closeTabs(contextBatchTabs.slice(index + 1).map((tab) => tab.id));
            setTabMenu(undefined);
          }}
          onCloseAll={() => {
            void closeTabs(contextBatchTabs.map((tab) => tab.id));
            setTabMenu(undefined);
          }}
          onDismiss={() => setTabMenu(undefined)}
        />
      )}

      <TerminalShortcutBar
        active={terminalContentActive && !currentTab.disconnected}
        enabled={settings.data?.terminal.shortcutBarEnabled ?? true}
        buttons={
          settings.data?.terminal.shortcutBarButtons ??
          DEFAULT_TERMINAL_SHORTCUT_BUTTONS.map((button) => ({ ...button }))
        }
        onButtonsChange={updateTerminalShortcutButtons}
        onSend={sendActiveTerminalShortcut}
      />

      <footer className="app-statusbar">
        <span>
          <span className={`runtime-led ${ready ? 'ready' : 'error'}`} />{' '}
          {ready ? x('app.connected') : x('app.connectionInterrupted')}
        </span>
        <BatchInput send={sendTerminalBatchInput} />
        <QuickCommandPopover
          client={client}
          bookmarkTree={bookmarkTree.data}
          ready={ready}
          onSend={sendActiveTerminalShortcut}
        />
        <CommandHistoryPopover
          client={client}
          settings={settings.data}
          ready={ready}
          activeTerminalId={activeTerminalId}
        />
        <button
          className={terminalInformationOpen ? 'status-information active' : 'status-information'}
          aria-expanded={terminalInformationOpen}
          disabled={!currentTab}
          onClick={() => {
            if (aiInspectorOpen) setAiInspector(false);
            setTerminalInformationOpen((open) => !open);
          }}
        >
          <Info size={12} /> {x('app.information')}
        </button>
        <button
          className={activeTransfers.length ? 'status-transfer active' : 'status-transfer'}
          onClick={() => setTransferCenterOpen((open) => !open)}
        >
          <ArrowDownToLine size={12} />
          {x('app.transfers')}{' '}
          {activeTransfers.length
            ? x('app.transfersRunning', { count: activeTransfers.length })
            : (transfers.data?.length ?? 0)}
        </button>
        <span>
          {currentSessionMode === 'files' && currentTab?.kind === 'ssh'
            ? 'SFTP'
            : currentSessionMode === 'files' && currentTab?.kind === 'local'
              ? x('shell.fileManager')
              : currentTab?.kind === 'ssh'
                ? 'SSH'
                : currentTab?.kind === 'telnet'
                  ? 'Telnet'
                  : currentTab?.kind === 'serial'
                    ? 'Serial'
                    : currentTab?.kind === 'rdp'
                      ? 'RDP'
                      : currentTab?.kind === 'vnc'
                        ? 'VNC'
                        : currentTab?.kind === 'spice'
                          ? 'SPICE'
                          : currentTab?.kind === 'web'
                            ? 'Web'
                            : currentTab
                              ? 'Local PTY'
                              : x('app.localWorkspace')}
        </span>
        {terminalContentActive &&
          currentTab &&
          currentTab.kind !== 'rdp' &&
          currentTab.kind !== 'vnc' &&
          currentTab.kind !== 'spice' &&
          currentTab.kind !== 'web' &&
          !currentTab.disconnected && (
            <label className="status-encoding">
              <span>{x('app.encoding')}</span>
              <select
                aria-label={x('app.currentTerminalEncoding')}
                value={
                  terminalEncodingOverrides[currentTab.id] ??
                  currentTab.behavior?.encoding ??
                  DEFAULT_TERMINAL_BEHAVIOR.encoding
                }
                onChange={(event) => {
                  const encoding = event.target.value as TerminalBehavior['encoding'];
                  const terminalId = currentTab.id;
                  const liveIds = new Set(tabs.map((tab) => tab.id));
                  setTerminalEncodingOverrides((current) =>
                    Object.fromEntries([
                      ...Object.entries(current)
                        .filter(([id]) => id !== terminalId && liveIds.has(id))
                        .slice(-127),
                      [terminalId, encoding],
                    ]),
                  );
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
        <span className="status-end">
          {currentTab
            ? currentTab.title
            : (() => {
                const item = navigation.find((entry) => entry.id === section);
                return item ? x(item.messageKey) : '';
              })()}{' '}
          · {status.data ? `${status.data.latencyMs} ms · API ${status.data.apiVersion}` : '—'}
        </span>
      </footer>

      <div className="runtime-identity" role="status" aria-live="polite" aria-atomic="true">
        <h2
          data-testid="runtime-state"
          data-state={ready ? 'ready' : status.isError ? 'degraded' : 'connecting'}
        >
          {ready
            ? x('app.runtimeReady')
            : status.isError
              ? x('app.runtimeDegraded')
              : x('app.runtimeConnecting')}
        </h2>
        {detailsOpen && status.data && (
          <dl>
            <div>
              <dt>Runtime ID</dt>
              <dd data-testid="runtime-id">{status.data.metadata.runtimeId}</dd>
            </div>
            <div>
              <dt>Generation</dt>
              <dd data-testid="runtime-generation">{status.data.metadata.generation}</dd>
            </div>
            <div>
              <dt>{x('app.processId')}</dt>
              <dd>{status.data.metadata.pid}</dd>
            </div>
          </dl>
        )}
      </div>

      {paletteOpen && (
        <CommandPalette
          items={palette.items}
          usage={palette.usage}
          platform={platform}
          onClose={() => setPalette(false)}
          onExecute={executePaletteItem}
        />
      )}
      {bookmarkGroupDialog && (
        <BookmarkGroupDialog
          key={`${bookmarkGroupDialog.kind}:${
            bookmarkGroupDialog.kind === 'rename'
              ? bookmarkGroupDialog.id
              : (bookmarkGroupDialog.parentId ?? 'root')
          }`}
          title={
            bookmarkGroupDialog.kind === 'rename'
              ? x('app.renameGroup')
              : bookmarkGroupDialog.parentId
                ? x('app.newChildGroup')
                : x('app.newGroup')
          }
          {...(bookmarkGroupDialog.kind === 'rename'
            ? { initialValue: bookmarkGroupDialog.initialValue }
            : {})}
          submitLabel={bookmarkGroupDialog.kind === 'rename' ? x('app.save') : x('app.create')}
          onClose={() => setBookmarkGroupDialog(undefined)}
          onSubmit={(value) =>
            bookmarkGroupDialog.kind === 'rename'
              ? updateBookmarkTree((tree) =>
                  client.updateBookmarkGroup(tree, bookmarkGroupDialog.id, value),
                )
              : updateBookmarkTree((tree) =>
                  client.createBookmarkGroup(tree, {
                    parentId: bookmarkGroupDialog.parentId,
                    ...value,
                  }),
                )
          }
        />
      )}
      {sshConfigImportGrant && bookmarkTree.data && (
        <SshConfigImportDialog
          key={sshConfigImportGrant.grantId}
          client={client}
          rootGrant={sshConfigImportGrant}
          groupId={null}
          bookmarkTree={
            queryClient.getQueryData<BookmarkTreeValue>(['bookmark-tree']) ?? bookmarkTree.data
          }
          onClose={() => setSshConfigImportGrant(undefined)}
          onCommitted={async (result) => {
            queryClient.setQueryData(['bookmark-tree'], result.tree);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['hosts'] }),
              queryClient.invalidateQueries({ queryKey: ['connections'] }),
            ]);
          }}
          onTreeStale={() =>
            queryClient.invalidateQueries({ queryKey: ['bookmark-tree'] }).then(() => undefined)
          }
        />
      )}
      <InteractionOverlay client={client} queryClient={queryClient} />
    </div>
  );
}

function ActivityRailButton({
  active,
  item,
  expanded,
  label,
  portalContainer,
  onClick,
  children,
}: {
  active: boolean;
  item: VisibleActivityRailItem | 'ai';
  expanded?: boolean;
  label: string;
  portalContainer: RefObject<HTMLElement | null>;
  onClick(): void;
  children: ReactNode;
}) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger
        className={`activity-item ${active ? 'active' : ''}`}
        data-activity-item={item}
        aria-expanded={expanded}
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        onFocus={() => setOpen(true)}
        onClick={onClick}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal container={portalContainer} className="activity-rail-tooltip-portal">
        <Tooltip.Positioner
          className="activity-rail-tooltip-positioner"
          positionMethod="fixed"
          collisionBoundary={[]}
          side="left"
          sideOffset={8}
          collisionPadding={8}
        >
          <Tooltip.Popup id={tooltipId} className="activity-rail-tooltip" role="tooltip">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function WorkspaceSidebar({
  section,
  aiPanel,
  sectionPanel,
  hostManagerOpen,
  hostPanelTab,
  onHostPanelTabChange,
  onOpenHostManager,
  bookmarkTree,
  bookmarkBusy,
  hosts,
  connections,
  tabs,
  activeTerminalId,
  ready,
  runtimeError,
  onCollapse,
  onConnectBookmark,
  onEditBookmark,
  onDuplicateBookmark,
  onDeleteBookmark,
  onCreateBookmarkGroup,
  onRenameBookmarkGroup,
  onDeleteBookmarkGroup,
  onMoveBookmark,
  onImportSshConfig,
  onSelectSection,
  onOpenFiles,
  onSelectTerminal,
  onCloseTerminal,
  onCreateTerminal,
  historyPanel,
}: {
  section: WorkspaceSection;
  aiPanel?: ReactNode;
  sectionPanel: ReactNode;
  hostManagerOpen: boolean;
  hostPanelTab: 'bookmarks' | 'history';
  onHostPanelTabChange(tab: 'bookmarks' | 'history'): void;
  onOpenHostManager(): void;
  bookmarkTree: BookmarkTreeValue | undefined;
  bookmarkBusy: boolean;
  hosts: Host[];
  connections: Connection[];
  tabs: ReturnType<typeof useWorkspace.getState>['tabs'];
  activeTerminalId: string | undefined;
  ready: boolean;
  runtimeError: boolean;
  onCollapse(): void;
  onConnectBookmark(bookmark: Bookmark): void;
  onEditBookmark(bookmark: Bookmark): void;
  onDuplicateBookmark(bookmark: Bookmark): void;
  onDeleteBookmark(bookmark: Bookmark): void;
  onCreateBookmarkGroup(parentId: string | null): void;
  onRenameBookmarkGroup(id: string): void;
  onDeleteBookmarkGroup(id: string): void;
  onMoveBookmark(
    source: BookmarkTreeNodeRef,
    target: BookmarkTreeNodeRef,
    position: BookmarkDropPosition,
  ): void;
  onImportSshConfig(): void;
  onSelectSection(section: WorkspaceSection): void;
  onOpenFiles(connectionId?: string): void;
  onSelectTerminal(id: string): void;
  onCloseTerminal(id: string): void;
  onCreateTerminal(): void;
  historyPanel: ReactNode;
}) {
  const { x } = useI18n();
  const sectionMeta = navigation.find((item) => item.id === section) ?? navigation[0]!;
  const readyConnections = connections.filter((connection) => connection.state === 'ready');

  if (aiPanel) {
    return (
      <aside
        className="workspace-sidebar section-ai ai-inspector"
        aria-label={x('panels.aiInspector')}
      >
        <header>
          <span>
            <Bot size={14} /> {x('panels.aiInspector')}
          </span>
          <button onClick={onCollapse} aria-label={`${x('app.close')} ${x('panels.aiInspector')}`}>
            <PanelRightClose size={15} />
          </button>
        </header>
        {aiPanel}
      </aside>
    );
  }

  return (
    <aside className={`workspace-sidebar section-${section}`}>
      <header className="explorer-header">
        <div>
          <strong>{x(sectionMeta.messageKey)}</strong>
        </div>
        <button
          onClick={onCollapse}
          title={x('app.collapseSidebar')}
          aria-label={x('app.collapseSidebar')}
        >
          <PanelRightClose size={15} />
        </button>
      </header>

      {section === 'hosts' && (
        <div
          className="connection-source-tabs"
          role="tablist"
          aria-label={x('app.connectionSources')}
        >
          <button
            role="tab"
            aria-selected={hostPanelTab === 'bookmarks'}
            onClick={() => onHostPanelTabChange('bookmarks')}
          >
            {x('app.bookmarks')}
          </button>
          <button
            role="tab"
            aria-selected={hostPanelTab === 'history'}
            onClick={() => onHostPanelTabChange('history')}
          >
            {x('app.history')}
          </button>
        </div>
      )}

      <div
        className={`explorer-content ${section === 'hosts' && hostPanelTab === 'history' ? 'connection-history-open' : ''}`}
      >
        {section === 'hosts' && hostPanelTab === 'bookmarks' && !hostManagerOpen && (
          <>
            <div className="explorer-section-title bookmark-explorer-title">
              <span>{x('app.bookmarks')}</span>
              <button
                onClick={() => {
                  onOpenHostManager();
                }}
              >
                {x('shell.manage')}
              </button>
            </div>
            {bookmarkTree ? (
              <BookmarkTreePanel
                tree={bookmarkTree}
                busy={bookmarkBusy}
                onConnect={onConnectBookmark}
                onEdit={onEditBookmark}
                onDuplicate={onDuplicateBookmark}
                onDelete={onDeleteBookmark}
                onCreateGroup={onCreateBookmarkGroup}
                onRenameGroup={onRenameBookmarkGroup}
                onDeleteGroup={onDeleteBookmarkGroup}
                onMove={onMoveBookmark}
                onImportSshConfig={onImportSshConfig}
              />
            ) : (
              <div className="bookmark-tree-loading" aria-busy={bookmarkBusy}>
                {bookmarkBusy ? x('app.loadingBookmarks') : x('app.bookmarksUnavailable')}
              </div>
            )}
          </>
        )}

        {(section !== 'hosts' || (hostPanelTab === 'bookmarks' && hostManagerOpen)) && sectionPanel}

        {section === 'hosts' && hostPanelTab === 'history' && historyPanel}

        {(section === 'files' || section === 'tunnels') && (
          <>
            <div className="explorer-section-title">
              <span>{x('app.availableSshConnections')}</span>
              <small>{readyConnections.length}</small>
            </div>
            <div className="explorer-hosts">
              {readyConnections.map((connection) => {
                const host = hosts.find((item) => item.id === connection.hostId);
                return (
                  <button
                    key={connection.id}
                    onClick={() =>
                      section === 'files' ? onOpenFiles(connection.id) : onSelectSection(section)
                    }
                  >
                    <span className="host-status ready" />
                    <span className="explorer-item-copy">
                      <strong>{host?.name ?? connection.id.slice(0, 8)}</strong>
                      <small>
                        {section === 'files'
                          ? x('app.sftpAvailable')
                          : x('app.sshForwardAvailable')}
                      </small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                );
              })}
              {!readyConnections.length && (
                <button className="explorer-empty-action" onClick={() => onSelectSection('hosts')}>
                  <Server size={14} /> {x('app.connectHostFirst')}
                </button>
              )}
            </div>
            {section === 'files' && (
              <button className="explorer-empty-action" onClick={() => onOpenFiles()}>
                <Folder size={14} /> {x('shell.fileManager')}
              </button>
            )}
          </>
        )}
      </div>

      {section !== 'hosts' && (
        <section className="explorer-sessions">
          <div className="explorer-section-title">
            <span>{x('app.sessions')}</span>
            <button
              onClick={onCreateTerminal}
              title={x('app.newTerminalInSidebar')}
              aria-label={x('app.newLocalTerminal')}
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="session-list">
            {tabs.map((tab) => (
              <div className="explorer-session-row" key={tab.id}>
                <button
                  className={`session-main ${activeTerminalId === tab.id ? 'active' : ''}`}
                  onClick={() => onSelectTerminal(tab.id)}
                >
                  <span className={`session-dot ${tab.disconnected ? 'disconnected' : ''}`} />
                  <Terminal size={13} />
                  <span>{tab.title}</span>
                </button>
                <button
                  className="session-close"
                  onClick={() => onCloseTerminal(tab.id)}
                  aria-label={x('shell.closeTab', { title: tab.title })}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {!tabs.length && (
              <button className="session-empty" onClick={onCreateTerminal}>
                <Plus size={13} /> {x('app.newLocalTerminal')} <kbd>⌘T</kbd>
              </button>
            )}
          </div>
        </section>
      )}

      {section !== 'hosts' && (
        <div className="sidebar-runtime">
          <ShieldCheck size={15} />
          <div>
            <strong>
              {ready
                ? x('app.runtimeConnected')
                : runtimeError
                  ? x('app.connectionInterrupted')
                  : x('app.connecting')}
            </strong>
            <span>{x('app.loopbackSafeSession')}</span>
          </div>
          <span className={`runtime-led ${ready ? 'ready' : runtimeError ? 'error' : ''}`} />
        </div>
      )}
    </aside>
  );
}

function TabContextMenu({
  x,
  y,
  tab,
  canCloseRight,
  onPin,
  onDuplicate,
  onCloneNext,
  onNewTab,
  onReload,
  onReloadAll,
  onRename,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onDismiss,
}: {
  x: number;
  y: number;
  tab: ReturnType<typeof useWorkspace.getState>['tabs'][number] | undefined;
  canCloseRight: boolean;
  onPin(): void;
  onDuplicate(): void;
  onCloneNext(): void;
  onNewTab(): void;
  onReload(): void;
  onReloadAll(): void;
  onRename(): void;
  onClose(): void;
  onCloseOthers(): void;
  onCloseRight(): void;
  onCloseAll(): void;
  onDismiss(): void;
}) {
  const { x: translate } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onDismiss();
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('blur', onDismiss);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss]);
  if (!tab) return null;
  return (
    <div
      className="tab-context-menu"
      ref={menu}
      style={{
        left: Math.min(x, window.innerWidth - 204),
        top: Math.max(4, Math.min(y, window.innerHeight - 358)),
      }}
    >
      <header>
        <Terminal size={13} /> <span>{tab.title}</span>
      </header>
      <button onClick={onPin}>
        <Pin size={12} />
        {tab.pinned ? translate('app.unpinTab') : translate('app.pinTab')}
      </button>
      <button onClick={onNewTab}>{translate('app.newTab')}</button>
      <button onClick={onDuplicate}>{translate('app.duplicateTab')}</button>
      <button onClick={onCloneNext}>{translate('app.cloneToNextPane')}</button>
      <button onClick={onReload}>{translate('app.reconnectSession')}</button>
      <button onClick={onReloadAll}>{translate('app.reconnectAllSessions')}</button>
      <button onClick={onRename}>{translate('app.rename')}</button>
      <button onClick={onClose}>
        {translate('app.close')} <kbd>⌘W</kbd>
      </button>
      <button onClick={onCloseOthers}>{translate('app.closeOtherTabs')}</button>
      <button onClick={onCloseRight} disabled={!canCloseRight}>
        {translate('app.closeTabsToRight')}
      </button>
      <button className="danger-item" onClick={onCloseAll}>
        <Trash2 size={12} /> {translate('app.closeAllTabs')}
      </button>
    </div>
  );
}

function connectionForReconnect(
  tab: TerminalTab,
  connections: Connection[],
): Connection | undefined {
  if (tab.kind !== 'ssh') return undefined;
  const usable = (connection: Connection) =>
    connection.state !== 'closed' && connection.state !== 'closing';
  return (
    connections.find((connection) => connection.id === tab.connectionId && usable(connection)) ??
    connections.find((connection) => connection.hostId === tab.hostId && usable(connection))
  );
}

function addBounded<T>(items: Set<T>, value: T, capacity = 64): void {
  items.delete(value);
  items.add(value);
  while (items.size > capacity) {
    const oldest = items.values().next().value as T | undefined;
    if (oldest === undefined) break;
    items.delete(oldest);
  }
}

function duplicateBookmarkTitle(
  tree: BookmarkTreeValue,
  source: string,
  copyLabel: string,
): string {
  const escapedLabel = copyLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const stem = `${source.replace(new RegExp(`(?:\\s+${escapedLabel}(?:\\s+\\d+)?)$`, 'iu'), '')} ${copyLabel}`;
  const existing = new Set(tree.bookmarks.map(({ title }) => title.toLocaleLowerCase()));
  if (!existing.has(stem.toLocaleLowerCase())) return stem.slice(0, 100);
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${stem.slice(0, 100 - suffix.length)}${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `${stem.slice(0, 91)} ${crypto.randomUUID().slice(0, 8)}`;
}
