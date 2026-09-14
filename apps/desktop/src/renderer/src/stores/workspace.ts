import { create } from 'zustand';
import type {
  TerminalAppearance,
  TerminalBehavior,
  TerminalVisualSettings,
} from '@workspace/contracts';

export type WorkspaceSection = 'hosts' | 'files' | 'tunnels' | 'commands' | 'ai' | 'settings';
export type WorkspaceContentSurface = 'terminal' | 'section';
export type WorkspaceLayoutMode = 'c1' | 'c2' | 'r2' | 'c3' | 'r3' | 'c2x2' | 'c1r2' | 'r1c2';
export type FileManagerViewMode = 'local' | 'remote' | 'split';
export type TerminalSessionMode = 'terminal' | 'files';
export interface TerminalTab {
  id: string;
  title: string;
  kind: 'local' | 'ssh' | 'telnet' | 'serial' | 'rdp' | 'vnc' | 'spice' | 'web';
  hostId?: string | undefined;
  connectionId?: string | undefined;
  bookmarkId?: string | undefined;
  profileId?: string | undefined;
  connectionProfileId?: string | undefined;
  appearance?: TerminalAppearance | undefined;
  behavior?: TerminalBehavior | undefined;
  visual?: TerminalVisualSettings | undefined;
  tabNumber?: number | undefined;
  disconnected: boolean;
  pinned?: boolean;
  paneIndex?: number;
}

export interface PersistedWorkspaceLayout {
  section: WorkspaceSection;
  contentSurface?: WorkspaceContentSurface | undefined;
  sidebarOpen: boolean;
  split: boolean;
  tabs: Array<Omit<TerminalTab, 'disconnected' | 'pinned'> & { pinned: boolean }>;
  activeTerminalId: string | null;
  secondaryTerminalId: string | null;
  layoutMode?: WorkspaceLayoutMode;
  paneTerminalIds?: Array<string | null>;
  focusedPane?: number;
}

interface WorkspaceState {
  section: WorkspaceSection;
  contentSurface: WorkspaceContentSurface;
  detailsOpen: boolean;
  sidebarOpen: boolean;
  aiInspectorOpen: boolean;
  paletteOpen: boolean;
  tabs: TerminalTab[];
  activeTerminalId: string | undefined;
  secondaryTerminalId: string | undefined;
  split: boolean;
  layoutMode: WorkspaceLayoutMode;
  paneTerminalIds: Array<string | null>;
  focusedPane: number;
  terminalSessionModes: Record<string, TerminalSessionMode>;
  fileManagerView: FileManagerViewMode;
  fileManagerSplitPercent: number;
  activeFtpConnectionId: string | undefined;
  insertion?: { terminalId: string; text: string; nonce: string };
  terminalVisualPreview?: { terminalId: string; visual: TerminalVisualSettings } | undefined;
  setSection(section: WorkspaceSection): void;
  showSection(section?: WorkspaceSection): void;
  toggleDetails(): void;
  toggleSidebar(): void;
  toggleAiInspector(): void;
  setAiInspector(open: boolean): void;
  setPalette(open: boolean): void;
  addTerminal(tab: TerminalTab): void;
  insertTerminalAfter(referenceId: string, tab: TerminalTab): void;
  replaceTerminal(id: string, tab: TerminalTab): void;
  closeTerminal(id: string): void;
  renameTerminal(id: string, title: string): void;
  setTerminalVisual(id: string, visual?: TerminalVisualSettings): void;
  setTerminalVisualPreview(preview?: { terminalId: string; visual: TerminalVisualSettings }): void;
  moveTerminal(id: string, targetId: string, after?: boolean): void;
  moveTerminalToPane(id: string, index: number): void;
  pinTerminal(id: string): void;
  setActiveTerminal(id?: string): void;
  toggleSplit(): void;
  setLayoutMode(mode: WorkspaceLayoutMode): void;
  setPaneTerminal(index: number, id: string): void;
  focusPane(index: number): void;
  setTerminalSessionMode(id: string, mode: TerminalSessionMode): void;
  setFileManagerView(view: FileManagerViewMode): void;
  setFileManagerSplitPercent(percent: number): void;
  setActiveFtpConnection(id?: string): void;
  swapPanes(left: number, right: number): void;
  setSecondaryTerminal(id?: string): void;
  insertTerminal(terminalId: string, text: string): void;
  clearForGeneration(): void;
  restoreLayout(layout: PersistedWorkspaceLayout, liveTerminalIds?: ReadonlySet<string>): void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  section: 'hosts',
  contentSurface: 'section',
  detailsOpen: true,
  sidebarOpen: false,
  aiInspectorOpen: false,
  paletteOpen: false,
  tabs: [],
  activeTerminalId: undefined,
  secondaryTerminalId: undefined,
  split: false,
  layoutMode: 'c1',
  paneTerminalIds: [],
  focusedPane: 0,
  terminalSessionModes: {},
  fileManagerView: 'split',
  fileManagerSplitPercent: 50,
  activeFtpConnectionId: undefined,
  terminalVisualPreview: undefined,
  // Selecting an activity-rail item only changes the contextual side panel.
  // The terminal selection is independent so an open panel never destroys or
  // hides the current session. `showSection` is the explicit main-surface action.
  setSection: (section) => set({ section }),
  showSection: (section) =>
    set((state) => ({
      ...(section ? { section } : {}),
      contentSurface: 'section',
      ...(state.tabs.length ? {} : { activeTerminalId: undefined }),
    })),
  toggleDetails: () => set((state) => ({ detailsOpen: !state.detailsOpen })),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  toggleAiInspector: () => set((state) => ({ aiInspectorOpen: !state.aiInspectorOpen })),
  setAiInspector: (aiInspectorOpen) => set({ aiInspectorOpen }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  addTerminal: (tab) =>
    set((state) => {
      const next = {
        ...tab,
        tabNumber: tab.tabNumber ?? nextTabNumber(state.tabs),
        pinned: tab.pinned ?? false,
        paneIndex: state.focusedPane,
      };
      const tabs = state.tabs.some((item) => item.id === tab.id)
        ? state.tabs
        : [...state.tabs, next];
      const paneTerminalIds = [...state.paneTerminalIds];
      paneTerminalIds[state.focusedPane] = tab.id;
      return {
        tabs,
        contentSurface: 'terminal',
        activeTerminalId: tab.id,
        terminalSessionModes: { ...state.terminalSessionModes, [tab.id]: 'terminal' },
        paneTerminalIds: normalizedPanes(tabs, paneCount(state.layoutMode), paneTerminalIds),
      };
    }),
  insertTerminalAfter: (referenceId, tab) =>
    set((state) => {
      if (state.tabs.some((item) => item.id === tab.id)) return state;
      const referenceIndex = state.tabs.findIndex((item) => item.id === referenceId);
      const reference = state.tabs[referenceIndex];
      if (referenceIndex < 0 || !reference) return state;
      const paneIndex = paneOf(reference);
      const next = {
        ...tab,
        tabNumber: tab.tabNumber ?? nextTabNumber(state.tabs),
        paneIndex,
        pinned: tab.pinned ?? reference.pinned ?? false,
      };
      const tabs = [...state.tabs];
      tabs.splice(referenceIndex + 1, 0, next);
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[paneIndex] = next.id;
      return {
        tabs,
        contentSurface: 'terminal',
        terminalSessionModes: { ...state.terminalSessionModes, [tab.id]: 'terminal' },
        paneTerminalIds,
        focusedPane: paneIndex,
        activeTerminalId: next.id,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  replaceTerminal: (id, tab) =>
    set((state) => {
      if (tab.id !== id && state.tabs.some((item) => item.id === tab.id)) return state;
      const index = state.tabs.findIndex((item) => item.id === id);
      const source = state.tabs[index];
      if (index < 0 || !source) return state;
      const replacement: TerminalTab = {
        ...tab,
        title: source.title,
        kind: source.kind,
        hostId: tab.hostId ?? source.hostId,
        connectionId: tab.connectionId ?? source.connectionId,
        tabNumber: source.tabNumber ?? tab.tabNumber ?? nextTabNumber(state.tabs),
        paneIndex: paneOf(source),
        pinned: source.pinned ?? false,
      };
      const tabs = [...state.tabs];
      tabs[index] = replacement;
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds.map((terminalId) =>
          terminalId === id ? replacement.id : terminalId,
        ),
      );
      const activeTerminalId =
        state.activeTerminalId === id ? replacement.id : state.activeTerminalId;
      const terminalSessionModes = { ...state.terminalSessionModes };
      if (replacement.id !== id) {
        terminalSessionModes[replacement.id] = terminalSessionModes[id] ?? 'terminal';
        delete terminalSessionModes[id];
      }
      return {
        tabs,
        contentSurface: 'terminal',
        terminalSessionModes,
        paneTerminalIds,
        activeTerminalId,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  closeTerminal: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds.map((terminalId) => (terminalId === id ? null : terminalId)),
      );
      const focusedPane = Math.max(0, Math.min(state.focusedPane, paneCount(state.layoutMode) - 1));
      const activeTerminalId =
        state.activeTerminalId === id
          ? (paneTerminalIds[focusedPane] ??
            paneTerminalIds.find((terminalId): terminalId is string => terminalId !== null) ??
            tabs.at(-1)?.id)
          : state.activeTerminalId;
      const terminalSessionModes = { ...state.terminalSessionModes };
      delete terminalSessionModes[id];
      return {
        tabs,
        contentSurface: tabs.length ? state.contentSurface : 'section',
        terminalSessionModes,
        activeTerminalId,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
        paneTerminalIds,
        focusedPane,
      };
    }),
  renameTerminal: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, title: title.trim() || tab.title } : tab,
      ),
    })),
  setTerminalVisual: (id, visual) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, visual } : tab)),
    })),
  setTerminalVisualPreview: (terminalVisualPreview) => set({ terminalVisualPreview }),
  moveTerminal: (id, targetId, after = false) =>
    set((state) => {
      if (id === targetId) return state;
      const sourceIndex = state.tabs.findIndex((tab) => tab.id === id);
      const target = state.tabs.find((tab) => tab.id === targetId);
      if (sourceIndex < 0 || !target) return state;
      const tabs = [...state.tabs];
      const [source] = tabs.splice(sourceIndex, 1);
      if (!source) return state;
      const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
      const sourcePane = paneOf(source);
      const targetPane = paneOf(target);
      tabs.splice(targetIndex + (after ? 1 : 0), 0, { ...source, paneIndex: targetPane });
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[targetPane] = id;
      return {
        tabs,
        contentSurface: 'terminal',
        paneTerminalIds,
        focusedPane: targetPane,
        activeTerminalId: id,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
        ...(sourcePane === targetPane ? {} : { split: state.layoutMode !== 'c1' }),
      };
    }),
  moveTerminalToPane: (id, index) =>
    set((state) => {
      if (index < 0 || index >= paneCount(state.layoutMode)) return state;
      const source = state.tabs.find((tab) => tab.id === id);
      if (!source) return state;
      const tabs = state.tabs.map((tab) => (tab.id === id ? { ...tab, paneIndex: index } : tab));
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[index] = id;
      return {
        tabs,
        contentSurface: 'terminal',
        paneTerminalIds,
        focusedPane: index,
        activeTerminalId: id,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  pinTerminal: (id) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
    })),
  setActiveTerminal: (activeTerminalId) =>
    set((state) => {
      if (!activeTerminalId) return { activeTerminalId, contentSurface: 'section' };
      const tab = state.tabs.find((item) => item.id === activeTerminalId);
      if (!tab) return state;
      const focusedPane = paneOf(tab);
      const paneTerminalIds = normalizedPanes(
        state.tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[focusedPane] = activeTerminalId;
      return {
        contentSurface: 'terminal',
        activeTerminalId,
        focusedPane,
        paneTerminalIds,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  toggleSplit: () =>
    set((state) => transitionLayout(state, state.layoutMode === 'c1' ? 'c2' : 'c1')),
  setLayoutMode: (layoutMode) => set((state) => transitionLayout(state, layoutMode)),
  setPaneTerminal: (index, id) =>
    set((state) => {
      if (index < 0 || index >= paneCount(state.layoutMode)) return state;
      const source = state.tabs.find((tab) => tab.id === id);
      if (!source) return state;
      const tabs = state.tabs.map((tab) => (tab.id === id ? { ...tab, paneIndex: index } : tab));
      const paneTerminalIds = normalizedPanes(
        tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[index] = id;
      return {
        tabs,
        contentSurface: 'terminal',
        paneTerminalIds,
        focusedPane: index,
        activeTerminalId: id,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  focusPane: (focusedPane) =>
    set((state) => ({
      focusedPane,
      contentSurface: state.tabs.length ? 'terminal' : state.contentSurface,
      activeTerminalId: state.paneTerminalIds[focusedPane] ?? state.activeTerminalId,
    })),
  setTerminalSessionMode: (id, mode) =>
    set((state) => {
      const tab = state.tabs.find((item) => item.id === id);
      if (!tab) return state;
      const terminalSessionMode =
        mode === 'files' && (tab.kind === 'local' || tab.kind === 'ssh') ? 'files' : 'terminal';
      const focusedPane = paneOf(tab);
      const paneTerminalIds = normalizedPanes(
        state.tabs,
        paneCount(state.layoutMode),
        state.paneTerminalIds,
      );
      paneTerminalIds[focusedPane] = id;
      return {
        contentSurface: 'terminal',
        activeTerminalId: id,
        focusedPane,
        paneTerminalIds,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
        terminalSessionModes: {
          ...state.terminalSessionModes,
          [id]: terminalSessionMode,
        },
      };
    }),
  setFileManagerView: (fileManagerView) => set({ fileManagerView }),
  setFileManagerSplitPercent: (fileManagerSplitPercent) =>
    set({ fileManagerSplitPercent: Math.max(25, Math.min(75, fileManagerSplitPercent)) }),
  setActiveFtpConnection: (activeFtpConnectionId) => set({ activeFtpConnectionId }),
  swapPanes: (left, right) =>
    set((state) => {
      if (
        left < 0 ||
        right < 0 ||
        left >= paneCount(state.layoutMode) ||
        right >= paneCount(state.layoutMode)
      )
        return state;
      const paneTerminalIds = [...state.paneTerminalIds];
      const leftTerminalId = paneTerminalIds[left] ?? null;
      const rightTerminalId = paneTerminalIds[right] ?? null;
      paneTerminalIds[left] = rightTerminalId;
      paneTerminalIds[right] = leftTerminalId;
      return {
        tabs: state.tabs.map((tab) => {
          if (paneOf(tab) === left) return { ...tab, paneIndex: right };
          if (paneOf(tab) === right) return { ...tab, paneIndex: left };
          return tab;
        }),
        paneTerminalIds,
        secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      };
    }),
  setSecondaryTerminal: (secondaryTerminalId) => set({ secondaryTerminalId }),
  insertTerminal: (terminalId, text) =>
    set({ insertion: { terminalId, text, nonce: crypto.randomUUID() } }),
  clearForGeneration: () =>
    set((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, disconnected: true })),
      terminalSessionModes: {},
      activeFtpConnectionId: undefined,
      terminalVisualPreview: undefined,
    })),
  restoreLayout: (layout, liveTerminalIds = new Set()) => {
    const layoutMode = layout.layoutMode ?? (layout.split ? 'c2' : 'c1');
    const legacySplit = !layout.layoutMode && !layout.paneTerminalIds && layout.split;
    const usedTabNumbers = new Set(
      layout.tabs.flatMap((tab) => (tab.tabNumber === undefined ? [] : [tab.tabNumber])),
    );
    let fallbackTabNumber = 1;
    const tabs = layout.tabs.map((tab) => {
      while (usedTabNumbers.has(fallbackTabNumber)) fallbackTabNumber += 1;
      const tabNumber = tab.tabNumber ?? fallbackTabNumber++;
      usedTabNumbers.add(tabNumber);
      return {
        ...tab,
        tabNumber,
        paneIndex:
          legacySplit && tab.id === layout.secondaryTerminalId
            ? 1
            : Math.min(tab.paneIndex ?? 0, paneCount(layoutMode) - 1),
        disconnected: !liveTerminalIds.has(tab.id),
      };
    });
    const focusedPane = Math.max(
      0,
      Math.min(layout.focusedPane ?? 0, paneCount(layoutMode) - 1, 3),
    );
    const paneTerminalIds = normalizedPanes(
      tabs,
      paneCount(layoutMode),
      layout.paneTerminalIds ??
        [layout.activeTerminalId, layout.secondaryTerminalId].filter((id): id is string => !!id),
    );
    if (
      layout.activeTerminalId &&
      tabs.some((tab) => tab.id === layout.activeTerminalId) &&
      !paneTerminalIds.includes(layout.activeTerminalId)
    ) {
      const active = tabs.find((tab) => tab.id === layout.activeTerminalId);
      paneTerminalIds[active ? paneOf(active) : focusedPane] = layout.activeTerminalId;
    }
    set({
      section: layout.section,
      contentSurface:
        layout.contentSurface ?? (layout.activeTerminalId && tabs.length ? 'terminal' : 'section'),
      sidebarOpen: layout.sidebarOpen,
      tabs,
      activeTerminalId: layout.activeTerminalId ?? undefined,
      secondaryTerminalId: paneTerminalIds[1] ?? undefined,
      split: layoutMode !== 'c1',
      layoutMode,
      paneTerminalIds,
      focusedPane,
      terminalSessionModes: {},
    });
  },
}));

export function paneCount(layout: WorkspaceLayoutMode): number {
  if (layout === 'c1') return 1;
  if (layout === 'c2' || layout === 'r2') return 2;
  if (layout === 'c2x2') return 4;
  return 3;
}

function normalizedPanes(
  tabs: TerminalTab[],
  count: number,
  current: Array<string | null> = [],
): Array<string | null> {
  const available = new Set(tabs.map((tab) => tab.id));
  const assigned = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const id = current[index];
    const currentTab = id ? tabs.find((tab) => tab.id === id) : undefined;
    if (id && available.has(id) && !assigned.has(id) && paneOf(currentTab!) === index) {
      assigned.add(id);
      return id;
    }
    const fallback = tabs.find((tab) => paneOf(tab) === index && !assigned.has(tab.id));
    if (!fallback) return null;
    assigned.add(fallback.id);
    return fallback.id;
  });
}

export function paneOf(tab: Pick<TerminalTab, 'paneIndex'>): number {
  return tab.paneIndex ?? 0;
}

export function nextTabNumber(tabs: ReadonlyArray<Pick<TerminalTab, 'tabNumber'>>): number {
  const used = new Set(tabs.flatMap((tab) => (tab.tabNumber === undefined ? [] : [tab.tabNumber])));
  const highest = Math.max(0, ...used);
  if (highest < 9_999) return highest + 1;
  for (let value = 1; value <= 9_999; value += 1) if (!used.has(value)) return value;
  return 9_999;
}

export function paneTabsInDisplayOrder(tabs: TerminalTab[], paneIndex: number): TerminalTab[] {
  return tabs
    .filter((tab) => paneOf(tab) === paneIndex)
    .map((tab, canonicalIndex) => ({ tab, canonicalIndex }))
    .sort(
      (left, right) =>
        Number(!!right.tab.pinned) - Number(!!left.tab.pinned) ||
        left.canonicalIndex - right.canonicalIndex,
    )
    .map(({ tab }) => tab);
}

function transitionLayout(state: WorkspaceState, layoutMode: WorkspaceLayoutMode) {
  const count = paneCount(layoutMode);
  const focusedPane = Math.max(0, Math.min(state.focusedPane, count - 1));
  const tabs = state.tabs.map((tab) => ({
    ...tab,
    paneIndex: paneOf(tab) >= count ? focusedPane : paneOf(tab),
  }));
  const paneTerminalIds = normalizedPanes(tabs, count, state.paneTerminalIds);
  if (
    state.activeTerminalId &&
    tabs.some((tab) => tab.id === state.activeTerminalId) &&
    !paneTerminalIds.includes(state.activeTerminalId)
  ) {
    const active = tabs.find((tab) => tab.id === state.activeTerminalId);
    paneTerminalIds[active ? paneOf(active) : focusedPane] = state.activeTerminalId;
  }
  return {
    tabs,
    layoutMode,
    paneTerminalIds,
    focusedPane,
    split: layoutMode !== 'c1',
    secondaryTerminalId: paneTerminalIds[1] ?? undefined,
  };
}
