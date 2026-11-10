import { terminalVisualSettingsSchema } from '@axterm/plugin-api/terminals';
import type { TerminalVisualSettings } from '@axterm/plugin-api/terminals';
import type { WorkspacePresentation, WorkspaceLayoutMode } from '@axterm/plugin-api/configuration';
import type {
  WorkspaceUi,
  WorkspaceTab,
  WorkspaceTabRegistration,
  WorkspaceNavigation,
  WorkspaceSnapshot,
  WorkspaceArrangementUi,
} from '@axterm/ui/workspace';
interface TabOwner {
  tab: WorkspaceTab;
  close: (signal: AbortSignal) => Promise<void>;
  closing?: Promise<void>;
}
/** Owns arrangement and UI registrations; it never starts or persists business work. */
export class WorkspaceStore implements WorkspaceUi {
  private readonly lifetime = new AbortController();
  private readonly tabs = new Map<string, TabOwner>();
  private readonly navigation = new Map<string, WorkspaceNavigation>();
  private readonly actions = new Map<string, (signal: AbortSignal) => void | Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();
  private intentRevision = 0;
  private mode: WorkspaceLayoutMode = 'c1';
  private paneTabIds: (string | null)[] = [null];
  private focusedPane = 0;
  private maximizedPane: number | undefined;
  private ratios = { x: 50, x2: 66.67, y: 50, y2: 66.67 };
  private readonly arrangement = new Map<
    string,
    { pinned: boolean; paneIndex: number; tabNumber: number }
  >();
  readonly arrange: WorkspaceArrangementUi = {
    setLayout: (mode) => this.setLayout(mode),
    resizePane: (axis, percent) => {
      this.assert();
      if (!['x', 'x2', 'y', 'y2'].includes(axis) || !Number.isFinite(percent))
        throw Error('WORKSPACE_PANE_RATIO_INVALID');
      let min = 10,
        max = 90;
      if (this.mode === 'c3') {
        if (axis === 'x') max = this.ratios.x2 - 10;
        if (axis === 'x2') min = this.ratios.x + 10;
      }
      if (this.mode === 'r3') {
        if (axis === 'y') max = this.ratios.y2 - 10;
        if (axis === 'y2') min = this.ratios.y + 10;
      }
      this.ratios = { ...this.ratios, [axis]: Math.max(min, Math.min(max, percent)) };
      this.intentRevision++;
      this.changed();
    },
    focusPane: (index) => this.focusPane(index),
    maximizePane: (index) => {
      this.assert();
      if (index !== undefined) this.assertPane(index);
      this.maximizedPane = index;
      this.intentRevision++;
      this.changed();
    },
    moveToPane: (id, index) => this.moveToPane(id, index),
    swapPanes: (left, right) => {
      this.assert();
      this.assertPane(left);
      this.assertPane(right);
      if (left === right) return;
      const swapped = (index: number) => (index === left ? right : index === right ? left : index);
      for (const [id, item] of this.arrangement)
        this.arrangement.set(id, { ...item, paneIndex: swapped(item.paneIndex) });
      [this.paneTabIds[left], this.paneTabIds[right]] = [
        this.paneTabIds[right]!,
        this.paneTabIds[left]!,
      ];
      this.focusedPane = swapped(this.focusedPane);
      if (this.maximizedPane !== undefined) this.maximizedPane = swapped(this.maximizedPane);
      this.intentRevision++;
      this.changed();
    },
    moveTab: (id, target, after) => this.moveTab(id, target, after),
    renameTab: (id, title) => {
      this.assertTab(id);
      this.validate(title);
      this.titleOverrides.set(id, title.trim());
      this.intentRevision++;
      this.changed();
    },
    pinTab: (id) => {
      this.assertTab(id);
      const value = this.arrangement.get(id)!;
      this.arrangement.set(id, { ...value, pinned: !value.pinned });
      this.intentRevision++;
      this.changed();
    },
    closeTabs: async (kind, referenceId) => {
      this.assertTab(referenceId);
      const pane = this.arrangement.get(referenceId)!.paneIndex;
      const tabs = this.snapshot.tabs.filter((tab) => tab.paneIndex === pane);
      const index = tabs.findIndex((tab) => tab.id === referenceId);
      const targets = tabs.filter(
        (tab, position) =>
          kind === 'all' || (kind === 'others' ? tab.id !== referenceId : position > index),
      );
      // Failures keep their owner and stop this explicit sequence; do not erase a failed close.
      for (const tab of targets) {
        this.lifetime.signal.throwIfAborted();
        await this.closeTab(tab.id);
      }
    },
  };
  private presentationGeneration: string | undefined;
  private restoredActive: string | null = null;
  private restoredNavigation: { id: string; revision: number } | undefined;
  private readonly savedOrder = new Map<string, number>();
  private readonly captions = new Map<string, WorkspacePresentation['tabs'][number]>();
  private readonly titleOverrides = new Map<string, string>();
  private readonly terminalVisuals = new Map<string, TerminalVisualSettings>();
  private section = 'hosts';
  private sidebarSection: string | undefined;
  private previousSection: { section: string; sidebarOpen: boolean } | undefined;
  private activeTabId: string | undefined;
  private sidebarOpen = false;
  private open = true;
  private snapshot: WorkspaceSnapshot = Object.freeze({
    section: 'hosts',
    sidebarOpen: false,
    activeTabId: undefined,
    tabs: Object.freeze([]),
    navigation: Object.freeze([]),
  });
  getSnapshot = (): WorkspaceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.assert();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  selectSection(section: string, options?: { readonly sidebar?: boolean }): void {
    this.assert();
    if (!this.navigation.has(section)) throw new Error('WORKSPACE_SECTION_UNAVAILABLE');
    if (options?.sidebar && this.navigation.get(section)?.view === 'section')
      throw new Error('WORKSPACE_SIDEBAR_SECTION_INVALID');
    const fullPage = this.navigation.get(section)?.view === 'section';
    if (!options?.sidebar) {
      if (fullPage && this.navigation.get(this.section)?.view !== 'section')
        this.previousSection = { section: this.section, sidebarOpen: this.sidebarOpen };
      else if (!fullPage) this.previousSection = undefined;
    }
    this.intentRevision++;
    this.restoredActive = null;
    if (options?.sidebar && this.navigation.get(this.section)?.view === 'section') {
      this.sidebarSection = section;
    } else {
      this.section = section;
      this.sidebarSection = undefined;
    }
    this.sidebarOpen = true;
    this.changed();
  }
  closeSection(): void {
    this.assert();
    if (this.navigation.get(this.section)?.view !== 'section') return;
    const previous = this.previousSection;
    this.intentRevision++;
    this.restoredActive = null;
    this.previousSection = undefined;
    this.sidebarSection = undefined;
    this.section = previous && this.navigation.has(previous.section) ? previous.section : 'hosts';
    this.sidebarOpen =
      previous && this.navigation.has(previous.section) ? previous.sidebarOpen : false;
    this.changed();
  }
  toggleSidebar(): void {
    this.assert();
    this.intentRevision++;
    this.sidebarOpen = !this.sidebarOpen;
    this.changed();
  }
  selectTab(id: string): void {
    this.assert();
    if (!this.tabs.has(id)) throw new Error('WORKSPACE_TAB_UNAVAILABLE');
    this.intentRevision++;
    this.restoredActive = null;
    this.activateView(id);
    if (this.navigation.get(this.section)?.view === 'section' && this.navigation.has('sessions'))
      this.section = 'sessions';
    this.changed();
  }
  registerTab(
    tab: WorkspaceTab,
    close: (signal: AbortSignal) => Promise<void>,
  ): WorkspaceTabRegistration {
    this.assert();
    this.validate(tab.id);
    this.validate(tab.kind);
    this.validate(tab.title);
    if (this.tabs.has(tab.id) || this.tabs.size >= 128) throw new Error('WORKSPACE_TAB_CONFLICT');
    const owned: TabOwner = { tab: Object.freeze({ ...tab }), close };
    this.tabs.set(tab.id, owned);
    if (!this.arrangement.has(tab.id)) {
      const highest = Math.max(0, ...[...this.arrangement.values()].map((item) => item.tabNumber));
      const tabNumber =
        highest < 9999
          ? highest + 1
          : Array.from({ length: 9999 }, (_, index) => index + 1).find(
              (number) => ![...this.arrangement.values()].some((item) => item.tabNumber === number),
            )!;
      this.arrangement.set(tab.id, { pinned: false, paneIndex: this.focusedPane, tabNumber });
    }
    if (this.restoredActive === tab.id) this.activateView(tab.id);
    this.changed();
    let active = true;
    return {
      present: (input) => {
        if (!active || this.tabs.get(tab.id) !== owned) throw Error('WORKSPACE_TAB_OWNER_CHANGED');
        if (input.title !== undefined) this.validate(input.title);
        if (input.terminalVisual !== undefined) {
          const visual = terminalVisualSettingsSchema.parse(input.terminalVisual);
          Object.freeze(visual.background);
          this.terminalVisuals.set(tab.id, Object.freeze(visual));
          this.intentRevision++;
          this.changed();
        }
        if (input.title !== undefined) {
          this.validate(input.title);
          this.titleOverrides.set(tab.id, input.title);
          this.intentRevision++;
          this.changed();
        }
      },
      update: (next) => {
        this.assert();
        if (
          !active ||
          this.tabs.get(tab.id) !== owned ||
          next.id !== tab.id ||
          next.kind !== tab.kind
        )
          throw new Error('WORKSPACE_TAB_OWNER_CHANGED');
        this.validate(next.title);
        owned.tab = Object.freeze({ ...next });
        this.changed();
      },
      activate: () => {
        this.assert();
        if (!active || this.tabs.get(tab.id) !== owned)
          throw new Error('WORKSPACE_TAB_UNAVAILABLE');
        this.intentRevision++;
        this.restoredActive = null;
        this.activateView(tab.id);
        if (
          this.navigation.get(this.section)?.view === 'section' &&
          this.navigation.has('sessions')
        )
          this.section = 'sessions';
        this.changed();
      },
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.tabs.get(tab.id) === owned) {
          this.tabs.delete(tab.id);
          this.captions.delete(tab.id);
          this.titleOverrides.delete(tab.id);
          this.terminalVisuals.delete(tab.id);
          this.savedOrder.delete(tab.id);
          this.arrangement.delete(tab.id);
          this.normalizePanes();
          if (this.activeTabId === tab.id) {
            const fallback = [...this.tabs.keys()].at(-1);
            if (fallback) this.activateView(fallback);
            else this.activeTabId = undefined;
          }
          this.changed();
        }
      },
    };
  }
  closeTab(id: string): Promise<void> {
    this.assert();
    const owner = this.tabs.get(id);
    if (!owner) return Promise.resolve();
    if (owner.closing) return owner.closing;
    this.intentRevision++;
    this.restoredActive = null;
    const pending = Promise.resolve()
      .then(() => owner.close(this.lifetime.signal))
      .then(() => {
        if (this.tabs.get(id) === owner) {
          this.tabs.delete(id);
          this.captions.delete(id);
          this.titleOverrides.delete(id);
          this.terminalVisuals.delete(id);
          this.savedOrder.delete(id);
          this.arrangement.delete(id);
          this.normalizePanes();
          if (this.activeTabId === id) {
            const fallback = [...this.tabs.keys()].at(-1);
            if (fallback) this.activateView(fallback);
            else this.activeTabId = undefined;
          }
          this.changed();
        }
      })
      .finally(() => {
        delete owner.closing;
      });
    owner.closing = pending;
    return this.track(pending);
  }
  registerNavigation(item: WorkspaceNavigation): () => void {
    this.assert();
    this.validate(item.id);
    if (typeof item.label === 'string') this.validate(item.label);
    else {
      if (
        !item.label ||
        typeof item.label !== 'object' ||
        !Object.hasOwn(item.label, 'en') ||
        Object.keys(item.label).length > 128
      )
        throw new Error('WORKSPACE_NAVIGATION_INVALID');
      for (const [language, label] of Object.entries(item.label)) {
        this.validate(language);
        this.validate(label);
      }
    }
    if (
      this.navigation.has(item.id) ||
      this.navigation.size >= 32 ||
      (item.order !== undefined && !Number.isFinite(item.order))
    )
      throw new Error('WORKSPACE_NAVIGATION_CONFLICT');
    const owned = Object.freeze({
      ...item,
      label: typeof item.label === 'string' ? item.label : Object.freeze({ ...item.label }),
    });
    this.navigation.set(item.id, owned);
    if (
      this.restoredNavigation?.id === item.id &&
      this.restoredNavigation.revision === this.intentRevision
    )
      this.section = item.id;
    this.changed();
    return () => {
      if (this.navigation.get(item.id) === owned) {
        this.navigation.delete(item.id);
        if (this.previousSection?.section === item.id) this.previousSection = undefined;
        if (this.sidebarSection === item.id) {
          this.sidebarSection = undefined;
          this.sidebarOpen = false;
        }
        if (this.section === item.id) {
          this.section = [...this.navigation.keys()][0] ?? 'hosts';
          this.sidebarSection = undefined;
        }
        this.changed();
      }
    };
  }
  registerAction(id: string, action: (signal: AbortSignal) => void | Promise<void>): () => void {
    this.assert();
    this.validate(id);
    if (this.actions.has(id) || this.actions.size >= 256)
      throw new Error('WORKSPACE_ACTION_CONFLICT');
    this.actions.set(id, action);
    return () => {
      if (this.actions.get(id) === action) this.actions.delete(id);
    };
  }
  invokeAction(id: string): Promise<void> {
    this.assert();
    const action = this.actions.get(id);
    if (!action) return Promise.reject(new Error('WORKSPACE_ACTION_UNAVAILABLE'));
    if (this.pending.size >= 64) return Promise.reject(new Error('WORKSPACE_ACTION_CAPACITY'));
    return this.track(
      Promise.resolve().then(() => {
        this.assert();
        return action(this.lifetime.signal);
      }),
    );
  }
  bindPresentationGeneration(generation: string): boolean {
    const retired =
      this.presentationGeneration !== undefined && this.presentationGeneration !== generation;
    this.presentationGeneration = generation;
    if (retired) {
      this.captions.clear();
      this.restoredActive = null;
      this.restoredNavigation = undefined;
      // Live registrations own presentation independently of the Host generation.
      for (const id of this.arrangement.keys()) {
        if (this.tabs.has(id)) continue;
        this.arrangement.delete(id);
        this.savedOrder.delete(id);
        this.titleOverrides.delete(id);
        this.terminalVisuals.delete(id);
      }
      this.normalizePanes();
      this.changed();
    }
    return retired;
  }
  getPresentationRevision(): number {
    return this.intentRevision;
  }
  getPresentation(): WorkspacePresentation {
    const tabs: WorkspacePresentation['tabs'] = [...this.tabs.values()].map(({ tab }) => ({
      id: tab.id,
      kind: tab.kind,
      caption: this.titleOverrides.get(tab.id) ?? tab.title,
      ...this.arrangement.get(tab.id),
      ...(this.terminalVisuals.has(tab.id)
        ? { terminalVisual: this.terminalVisuals.get(tab.id)! }
        : {}),
      ...(this.titleOverrides.has(tab.id) ? { title: this.titleOverrides.get(tab.id)! } : {}),
    }));
    for (const caption of this.captions.values())
      if (!this.tabs.has(caption.id))
        tabs.push({ ...caption, ...this.arrangement.get(caption.id) });
    tabs.sort(
      (a, b) =>
        (this.savedOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (this.savedOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const selected = this.activeTabId ?? this.restoredActive;
    return {
      layout: {
        mode: this.mode,
        ratios: { ...this.ratios },
        paneTabIds: [...this.paneTabIds],
        focusedPane: this.focusedPane,
        ...(this.maximizedPane === undefined ? {} : { maximizedPane: this.maximizedPane }),
      },
      section: this.section,
      sidebarOpen: this.sidebarOpen,
      activeTabId: selected && tabs.some((tab) => tab.id === selected) ? selected : null,
      tabs,
    };
  }
  replacePresentation(value: WorkspacePresentation): void {
    this.intentRevision = 0;
    this.titleOverrides.clear();
    this.terminalVisuals.clear();
    this.arrangement.clear();
    this.restorePresentation(value);
    this.intentRevision++;
    if (this.restoredNavigation) this.restoredNavigation.revision = this.intentRevision;
    this.changed();
  }
  restorePresentation(value: WorkspacePresentation): void {
    // Current accepted registrations remain the only live views. No business IO is created here.
    const revision = this.intentRevision;
    this.captions.clear();
    this.savedOrder.clear();
    if (revision === 0) this.terminalVisuals.clear();
    value.tabs.forEach((tab, index) => {
      this.captions.set(tab.id, structuredClone(tab));
      if (revision === 0 && tab.terminalVisual) {
        const visual = terminalVisualSettingsSchema.parse(tab.terminalVisual);
        Object.freeze(visual.background);
        this.terminalVisuals.set(tab.id, Object.freeze(visual));
      }
      this.savedOrder.set(tab.id, index);
      if (revision === 0)
        this.arrangement.set(tab.id, {
          pinned: tab.pinned ?? false,
          paneIndex: tab.paneIndex ?? 0,
          tabNumber: tab.tabNumber ?? index + 1,
        });
      if (tab.title !== undefined && !this.titleOverrides.has(tab.id))
        this.titleOverrides.set(tab.id, tab.title);
    });
    if (revision === 0) {
      if (value.layout) {
        this.mode = value.layout.mode;
        this.ratios = value.layout.ratios
          ? { ...value.layout.ratios }
          : {
              x: this.mode === 'c3' ? 33.33 : 50,
              x2: 66.67,
              y: this.mode === 'r3' ? 33.33 : 50,
              y2: 66.67,
            };
        this.paneTabIds = [...value.layout.paneTabIds];
        this.focusedPane = value.layout.focusedPane;
        this.maximizedPane = value.layout.maximizedPane;
      }
      this.restoredActive = value.activeTabId;
      if (value.activeTabId && this.tabs.has(value.activeTabId))
        this.activateView(value.activeTabId);
      this.previousSection = undefined;
      this.sidebarSection = undefined;
      this.sidebarOpen = value.sidebarOpen;
      this.restoredNavigation = { id: value.section, revision: this.intentRevision };
      if (this.navigation.has(value.section)) this.section = value.section;
    }
    this.changed();
  }
  async dispose(): Promise<void> {
    this.open = false;
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
    this.actions.clear();
    this.tabs.clear();
    this.navigation.clear();
    this.arrangement.clear();
    this.captions.clear();
    this.titleOverrides.clear();
    this.terminalVisuals.clear();
    this.savedOrder.clear();
    this.listeners.clear();
  }
  private assertTab(id: string): void {
    this.assert();
    if (!this.tabs.has(id)) throw Error('WORKSPACE_TAB_UNAVAILABLE');
  }
  private assertPane(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= paneCount(this.mode))
      throw Error('WORKSPACE_PANE_UNAVAILABLE');
  }
  private activateView(id: string): void {
    this.previousSection = undefined;
    this.sidebarSection = undefined;
    this.activeTabId = id;
    this.focusedPane = this.arrangement.get(id)?.paneIndex ?? 0;
    this.paneTabIds[this.focusedPane] = id;
  }
  private normalizePanes(): void {
    const available = (id: string | null | undefined, index: number) =>
      id &&
      (this.tabs.has(id) || this.captions.has(id)) &&
      this.arrangement.get(id)?.paneIndex === index;
    this.paneTabIds = Array.from({ length: paneCount(this.mode) }, (_, index) =>
      available(this.paneTabIds[index], index)
        ? this.paneTabIds[index]!
        : ([...this.tabs.keys()].find((id) => this.arrangement.get(id)?.paneIndex === index) ??
          null),
    );
  }
  private setLayout(mode: WorkspaceLayoutMode): void {
    this.assert();
    if (!['c1', 'c2', 'r2', 'c3', 'r3', 'c2x2', 'c1r2', 'r1c2'].includes(mode))
      throw Error('WORKSPACE_LAYOUT_INVALID');
    this.mode = mode;
    this.ratios = {
      x: mode === 'c3' ? 33.33 : 50,
      x2: 66.67,
      y: mode === 'r3' ? 33.33 : 50,
      y2: 66.67,
    };
    this.focusedPane = Math.min(this.focusedPane, paneCount(mode) - 1);
    this.maximizedPane = undefined;
    for (const [id, item] of this.arrangement)
      if (item.paneIndex >= paneCount(mode))
        this.arrangement.set(id, { ...item, paneIndex: this.focusedPane });
    this.normalizePanes();
    if (this.activeTabId) this.activateView(this.activeTabId);
    this.intentRevision++;
    this.changed();
  }
  private focusPane(index: number): void {
    this.assert();
    this.assertPane(index);
    this.focusedPane = index;
    this.activeTabId = this.paneTabIds[index] ?? undefined;
    this.intentRevision++;
    this.changed();
  }
  private moveToPane(id: string, index: number): void {
    this.assertTab(id);
    this.assertPane(index);
    this.arrangement.set(id, { ...this.arrangement.get(id)!, paneIndex: index });
    this.normalizePanes();
    this.selectTab(id);
  }
  private moveTab(id: string, targetId: string, after = false): void {
    this.assertTab(id);
    this.assertTab(targetId);
    if (id === targetId) return;
    const ids = [...this.getPresentation().tabs.map((tab) => tab.id)].filter(
      (value) => value !== id,
    );
    const target = ids.indexOf(targetId);
    ids.splice(target + Number(after), 0, id);
    ids.forEach((value, index) => this.savedOrder.set(value, index));
    this.arrangement.set(id, {
      ...this.arrangement.get(id)!,
      paneIndex: this.arrangement.get(targetId)!.paneIndex,
    });
    this.normalizePanes();
    this.selectTab(id);
  }
  private track(pending: Promise<void>): Promise<void> {
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }
  private validate(value: string): void {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0'))
      throw new Error('WORKSPACE_INVALID_CONTRIBUTION');
  }
  private assert(): void {
    if (!this.open) throw new Error('WORKSPACE_CLOSED');
  }
  private changed(): void {
    if (!this.open) return;
    this.snapshot = Object.freeze({
      arrangement: Object.freeze({
        mode: this.mode,
        ratios: Object.freeze({ ...this.ratios }),
        paneTabIds: Object.freeze([...this.paneTabIds]),
        focusedPane: this.focusedPane,
        ...(this.maximizedPane === undefined ? {} : { maximizedPane: this.maximizedPane }),
      }),
      section: this.section,
      ...(this.sidebarSection === undefined ? {} : { sidebarSection: this.sidebarSection }),
      sidebarOpen: this.sidebarOpen,
      activeTabId: this.activeTabId,
      tabs: Object.freeze(
        [...this.tabs.values()]
          .sort(
            (a, b) =>
              Number(this.arrangement.get(b.tab.id)?.pinned ?? false) -
                Number(this.arrangement.get(a.tab.id)?.pinned ?? false) ||
              (this.savedOrder.get(a.tab.id) ?? Number.MAX_SAFE_INTEGER) -
                (this.savedOrder.get(b.tab.id) ?? Number.MAX_SAFE_INTEGER),
          )
          .map(({ tab }) =>
            Object.freeze({
              ...tab,
              ...this.arrangement.get(tab.id),
              ...(this.terminalVisuals.has(tab.id)
                ? { terminalVisual: this.terminalVisuals.get(tab.id)! }
                : {}),
              title: this.titleOverrides.get(tab.id) ?? tab.title,
            }),
          ),
      ),
      navigation: Object.freeze(
        [...this.navigation.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      ),
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('WORKSPACE_OBSERVER_FAILED');
      }
    }
  }
}

export function paneCount(mode: WorkspaceLayoutMode): number {
  return mode === 'c1' ? 1 : mode === 'c2' || mode === 'r2' ? 2 : mode === 'c2x2' ? 4 : 3;
}
