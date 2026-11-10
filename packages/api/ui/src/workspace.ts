import type { PersistedTerminalTab } from '@axterm/plugin-api/configuration';
import type { ClientFactsView } from '@axterm/plugin-api/types';
import type { DesktopWindowPresentationState } from '@axterm/plugin-api/shortcuts';
import type { AiBaseline } from '@axterm/plugin-api/ai';
import type { TerminalThemeInput } from '@axterm/plugin-api/terminals';
import type { TerminalVisualSettings } from '@axterm/plugin-api/terminals';
import type { WorkspaceLayoutMode } from '@axterm/plugin-api/configuration';
import type { CreateRemoteDesktopSession } from '@axterm/plugin-api/remote-desktop';
import type { RemoteFileTarget } from '@axterm/plugin-api/files';
import type { CreateTerminalInput } from '@axterm/plugin-api/terminals';
import type {
  CreateConnectionInput,
  CreateFtpConnectionInput,
  ReconnectConnectionHistoryInput,
  StartTunnelInput,
  TunnelProfileInput,
} from '@axterm/plugin-api/connections';
import type { LocalizedText } from './presentation.ts';
import type { ReactNode } from 'react';
import type { PropsRenderSlots } from './index.ts';

/** UI identity and arrangement only; business facts remain in their owner's Client model. */
export interface WorkspaceTab {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly terminalVisual?: TerminalVisualSettings;
  readonly pinned?: boolean;
  readonly paneIndex?: number;
  readonly tabNumber?: number;
  readonly icon?: 'terminal' | 'server' | 'files' | 'desktop' | 'web';
}
export interface WorkspaceNavigation {
  readonly id: string;
  readonly label: LocalizedText;
  readonly icon: ReactNode;
  readonly action?: string;
  readonly view?: 'section';
  readonly chrome?: 'settings';
  readonly order?: number;
}
export interface WorkspaceArrangement {
  readonly mode: WorkspaceLayoutMode;
  readonly paneTabIds: readonly (string | null)[];
  readonly focusedPane: number;
  readonly maximizedPane?: number;
  readonly ratios?: Readonly<{ x: number; x2: number; y: number; y2: number }>;
}
export interface WorkspaceArrangementUi {
  setLayout(mode: WorkspaceLayoutMode): void;
  resizePane(axis: 'x' | 'x2' | 'y' | 'y2', percent: number): void;
  focusPane(index: number): void;
  maximizePane(index?: number): void;
  moveToPane(id: string, index: number): void;
  swapPanes(left: number, right: number): void;
  moveTab(id: string, targetId: string, after?: boolean): void;
  renameTab(id: string, title: string): void;
  pinTab(id: string): void;
  closeTabs(kind: 'others' | 'right' | 'all', referenceId: string): Promise<void>;
}
export interface WorkspaceSnapshot {
  readonly arrangement?: WorkspaceArrangement;
  readonly section: string;
  readonly sidebarOpen: boolean;
  /** Transient side panel while a full-page section remains selected. */
  readonly sidebarSection?: string;
  readonly activeTabId: string | undefined;
  readonly tabs: readonly WorkspaceTab[];
  readonly navigation: readonly WorkspaceNavigation[];
}
export interface WorkspaceTabRegistration {
  update(tab: WorkspaceTab): void;
  present?(input: {
    readonly title?: string;
    readonly terminalVisual?: TerminalVisualSettings;
  }): void;
  activate(): void;
  dispose(): void;
}
/** Each contribution has one owner and an explicit disposer; duplicate ids are rejected. */
export interface WorkspaceUi {
  readonly arrange?: WorkspaceArrangementUi;
  getSnapshot(): WorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  selectSection(section: string, options?: { readonly sidebar?: boolean }): void;
  /** Return from a full-page section to the preceding pure workspace view. */
  closeSection?(): void;
  toggleSidebar(): void;
  selectTab(id: string): void;
  closeTab(id: string): Promise<void>;
  registerTab(
    tab: WorkspaceTab,
    close: (signal: AbortSignal) => Promise<void>,
  ): WorkspaceTabRegistration;
  registerNavigation(item: WorkspaceNavigation): () => void;
  registerAction(id: string, action: (signal: AbortSignal) => void | Promise<void>): () => void;
  invokeAction(id: string): Promise<void>;
}

/** Selected presentation contributions. Business admission and drain remain with the source owner. */
export interface WorkspacePaletteItem {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly group:
    'recent' | 'actions' | 'terminal' | 'sections' | 'sessions' | 'hosts' | 'workspaces';
  readonly shortcuts: readonly string[];
  readonly unavailableReason?: string | undefined;
  execute(): void | Promise<unknown>;
}
export interface WorkspacePaletteUi {
  registerSource(id: string, source: () => readonly WorkspacePaletteItem[]): () => void;
}
export interface WorkspacePanelOwner {
  readonly section: string;
  readonly activeTabId: string | undefined;
  /** Pure arrangement identity for an empty pane; never an execution authority. */
  readonly paneIndex?: number;
}
export interface WorkspaceSessionOwner {
  readonly tabId: string;
  readonly active: boolean;
}
export type WorkspaceChildSlot =
  | 'workspace.toolbar'
  | 'workspace.sidebar'
  | 'workspace.section'
  | 'workspace.section-toolbar'
  | 'workspace.session'
  | 'workspace.empty'
  | 'workspace.status'
  | 'workspace.overlay'
  | 'workspace.auxiliary'
  | 'workspace.monitor'
  | 'workspace.tab-menu';
export type WorkspaceRootShare = PropsRenderSlots<WorkspaceChildSlot>;
declare module './index.ts' {
  interface SlotMap {
    'workspace.toolbar': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'terminal.files': { kind: 'single'; scope: 'root'; owner: WorkspaceSessionOwner };
    'workspace.sidebar': { kind: 'keyed'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.section': { kind: 'keyed'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.section-toolbar': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.session': { kind: 'keyed'; scope: 'root'; owner: WorkspaceSessionOwner };
    'workspace.empty': { kind: 'single'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.empty.actions': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.empty.content': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.status': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.monitor': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.auxiliary': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.overlay': { kind: 'list'; scope: 'root'; owner: WorkspacePanelOwner };
    'workspace.tab-menu': { kind: 'list'; scope: 'root'; owner: { readonly tabId: string } };
    'terminal.context-menu': { kind: 'list'; scope: 'root'; owner: { readonly tabId: string } };
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceUi: WorkspaceUi;
    workspacePaletteUi: WorkspacePaletteUi;
    desktopWindow: DesktopWindowIdentity;
  }
}

/** Explicit user insertion owned by the live terminal renderer; never a business RPC or replay queue. */
export interface TerminalDraftUi {
  insertDraft(terminalId: string, text: string, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalDraftUi: TerminalDraftUi;
  }
}

/** Explicit UI admission; the terminal owner creates, waits for and activates its own view. */
export interface TerminalWorkspaceUi {
  getActiveDirectory?(): { connectionId: string; path: string } | undefined;
  open(
    input: CreateTerminalInput,
    signal?: AbortSignal,
    presentation?: { title?: string },
  ): Promise<string>;
  activate(id: string): void;
}
/** SSH launch remains owned by Connections, including trust/authentication and terminal admission. */
export type SshTerminalOptions = Omit<
  CreateTerminalInput,
  'kind' | 'connectionId' | 'cols' | 'rows'
> & { cols?: number; rows?: number; title?: string };
export interface SshFilesViewOptions {
  path?: string;
  title?: string;
  initialDirectoryGrantId?: string;
}
export type SshStartupTunnel = Omit<TunnelProfileInput, 'hostId'>;
export interface ConnectionWorkspaceUi {
  openHistory(
    id: string,
    input: ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
    options?: { signal?: AbortSignal; terminal?: SshTerminalOptions },
  ): Promise<string>;
  openSsh(
    input: CreateConnectionInput,
    options?: {
      signal?: AbortSignal;
      terminal?: SshTerminalOptions;
      filesOnly?: SshFilesViewOptions;
      filesAfterTerminal?: SshFilesViewOptions;
      tunnels?: readonly SshStartupTunnel[];
    },
  ): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalWorkspaceUi: TerminalWorkspaceUi;
    connectionWorkspaceUi: ConnectionWorkspaceUi;
  }
}

/** Retained product settings composition; feature owners supply their own content and facts. */
export type SettingsCategoryId =
  'common' | 'terminal' | 'shortcuts' | 'sync' | 'ai' | 'password' | 'legal';
export type SettingsTabId = 'setting' | 'profiles' | 'themes' | 'widgets';
export type SettingsSectionId = SettingsCategoryId | Exclude<SettingsTabId, 'setting'>;
export type SettingsSectionSlot = `settings.${SettingsSectionId}`;
export type SettingsRenderShare = PropsRenderSlots<SettingsSectionSlot>;
export interface SettingsSectionOwner {
  readonly section: SettingsSectionId;
}
declare module './index.ts' {
  interface SlotMap {
    'settings.common': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.terminal': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.shortcuts': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.sync': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.ai': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.password': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.legal': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.profiles': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.themes': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
    'settings.widgets': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwner };
  }
}

export interface FilesWorkspaceUi {
  /** Selected UI admission; Files owns all embedded resources and their actual drain. */
  prepareTerminalPane?(terminalId: string, generation: string): Promise<void>;
  releaseTerminalPane?(terminalId: string, generation: string): Promise<void>;
  openFtp(
    input: CreateFtpConnectionInput,
    options?: { signal?: AbortSignal; title?: string },
  ): Promise<string>;
  open(
    input?:
      | { kind: 'local'; title?: string; initialDirectoryGrantId?: string }
      | {
          kind: 'remote';
          target: RemoteFileTarget;
          path?: string;
          title?: string;
          initialDirectoryGrantId?: string;
        },
    signal?: AbortSignal,
  ): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    filesWorkspaceUi: FilesWorkspaceUi;
  }
}

/** Explicit native/user session intent. Catalog parses it and delegates to selected owners. */
export interface SessionLaunchUi {
  launch(source: string, signal?: AbortSignal): Promise<boolean>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionLaunchUi: SessionLaunchUi;
  }
}

export interface DesktopWindowIdentity {
  readonly id: string;
  readonly presentationSlot?: string;
}

/** UI admission only; Connections owns the start intent, outcome and background task. */
export interface TunnelWorkspaceUi {
  start(input: StartTunnelInput, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    tunnelWorkspaceUi: TunnelWorkspaceUi;
  }
}

export interface RemoteDesktopWorkspaceUi {
  open(input: CreateRemoteDesktopSession, signal?: AbortSignal): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteDesktopWorkspaceUi: RemoteDesktopWorkspaceUi;
  }
}

export interface WebSessionWorkspaceUi {
  open(bookmarkId: string, signal?: AbortSignal): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    webSessionWorkspaceUi: WebSessionWorkspaceUi;
  }
}

/** Explicit human input to one live, generation-owned renderer. No replay or cross-process RPC. */
export interface TerminalInputUi {
  sendInput(id: string, text: string, signal?: AbortSignal): Promise<void>;
}
export type AutomationWorkspaceSection = 'quick-commands' | 'batch-operations' | 'triggers';
export interface AutomationWorkspaceUi {
  open(section?: AutomationWorkspaceSection): void;
  runBatchGrant(grantId: string, generation: string, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalInputUi: TerminalInputUi;
    automationWorkspaceUi: AutomationWorkspaceUi;
  }
}

/** Explicit user operations on a currently mounted renderer; no business IO, broadcast or replay queue. */
export type TerminalViewAction =
  | 'search'
  | 'clear'
  | 'select-all'
  | 'copy'
  | 'paste'
  | 'paste-selection'
  | 'explain'
  | 'zoom-in'
  | 'zoom-out'
  | 'normal-buffer';
/** Opaque bounded selection ownership. No terminal text enters React state or a workspace store. */
export interface TerminalSelectionContext {
  readonly hasSelection: boolean;
  run(action: TerminalViewAction, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}
export interface TerminalViewUi {
  captureContext(id: string): TerminalSelectionContext;
  selectionAvailable(id: string): boolean;
  run(id: string, action: TerminalViewAction, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalViewUi: TerminalViewUi;
  }
}

/** Pure UI skin choice/preview; accepted terminal resources remain with their existing owner. */
export interface TerminalVisualUi {
  getSnapshot(): Readonly<{
    revision: number;
    previews: Readonly<Record<string, TerminalVisualSettings>>;
  }>;
  subscribe(listener: () => void): () => void;
  apply(id: string, visual: TerminalVisualSettings): void;
  preview(id: string, visual: TerminalVisualSettings): () => void;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalVisualUi: TerminalVisualUi;
  }
}

/** AI owns generation and cancellation; consumers receive a draft only. */
export interface AiThemeUi extends ClientFactsView<AiBaseline> {
  generateTheme(
    input: { modelId: string; prompt: string; draft?: TerminalThemeInput },
    signal?: AbortSignal,
  ): Promise<TerminalThemeInput>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiThemeUi: AiThemeUi;
  }
}

/** Explicit reply-only AI drafts. Generation and terminal identity are captured by the caller. */
export interface AiCommandSuggestionsUi extends ClientFactsView<AiBaseline> {
  suggestCommands(
    input: { modelId: string; generation: string; terminalId: string; prefix: string },
    signal?: AbortSignal,
  ): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiCommandSuggestionsUi: AiCommandSuggestionsUi;
  }
}

/** Explicit, validated external navigation owned by the Desktop plugin. */
export interface DesktopUi {
  openExternal(url: string, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopUi: DesktopUi;
  }
}

/** Current-generation terminal session lifecycle; stream retries remain a different renderer action. */
export interface TerminalSessionUi {
  disconnect(id: string): Promise<void>;
  reload(id: string, signal?: AbortSignal): Promise<string>;
  duplicate(id: string, nextPane?: boolean, signal?: AbortSignal): Promise<string>;
  cancelReconnect(id: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalSessionUi: TerminalSessionUi;
  }
}

/** History mutations retain the Terminals owner's original receipts and observed facts. */
export interface TerminalHistoryUi {
  remove(id: string, version: number, generation: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalHistoryUi: TerminalHistoryUi;
  }
}

/** Shell-owned window presentation only; no business/native object exposure. */
export interface DesktopWindowUi {
  act(
    action: 'fullscreen' | 'zoom-in' | 'zoom-out' | 'minimize' | 'toggle-maximize' | 'close',
  ): Promise<void>;
  getState(): Promise<DesktopWindowPresentationState>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopWindowUi: DesktopWindowUi;
  }
}

/** Session descriptions are read from the source owner; actual creation and cleanup stay there. */
export interface WorkspaceSessionDescriptionSource {
  isReady(generation: string): boolean;
  subscribe(listener: () => void): () => void;
  describe(id: string): PersistedTerminalTab | undefined;
  restore(input: PersistedTerminalTab, generation: string, signal: AbortSignal): Promise<string>;
}
export interface WorkspaceSessionDescriptions {
  isReady(kind: PersistedTerminalTab['kind'], generation: string): boolean;
  waitFor(
    kind: PersistedTerminalTab['kind'],
    generation: string,
    signal: AbortSignal,
  ): Promise<void>;
  register(
    kind: 'terminal' | 'remote-desktop' | 'web-session',
    source: WorkspaceSessionDescriptionSource,
  ): () => void;
  describe(tab: WorkspaceTab): PersistedTerminalTab;
  restore(input: PersistedTerminalTab, generation: string, signal: AbortSignal): Promise<string>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceSessionDescriptions: WorkspaceSessionDescriptions;
  }
}
/** Pauses only layout autosave; application IO and configuration transactions retain their owners. */
export interface WorkspaceAutosaveUi {
  pause(): Promise<() => void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceAutosaveUi: WorkspaceAutosaveUi;
  }
}
/** Native ingress gets the first startup decision; this capability creates no session itself. */
export interface DesktopStartupUi {
  claim(generation: string, signal: AbortSignal): Promise<'configured' | 'native' | 'claimed'>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopStartupUi: DesktopStartupUi;
  }
}

/** Catalog owns saved bookmark launch, including nonterminal file sessions. */
export interface CatalogStartupUi {
  openBookmark(id: string, generation: string, signal: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    catalogStartupUi: CatalogStartupUi;
  }
}

/** Explicit selection review only; AI owns preview and the visible draft, never silent execution. */
export interface AiTerminalExplanationUi {
  open(
    input: { readonly terminalId: string; readonly generation: string; readonly selection: string },
    signal?: AbortSignal,
  ): Promise<'opened' | 'unconfigured'>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    aiTerminalExplanationUi: AiTerminalExplanationUi;
  }
}
