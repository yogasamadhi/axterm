import { remoteErrorOf } from '@axterm/plugin-api';
import {
  workspaceLayoutSchema,
  namedWorkspaceSchema,
  workspacePresentationSchema,
  type NamedWorkspace,
  type WorkspacePresentation,
  type ConfigurationClientActions,
  type UpdateSettingsInput,
} from '@axterm/plugin-api/configuration';
import type { WorkspaceSessionDescriptions } from '@axterm/ui/workspace';
import type { WorkspaceStore } from './store.ts';
interface Intent {
  key: string;
  generation: string;
  version: number;
  input: NonNullable<UpdateSettingsInput['workspace']>;
}
export interface NamedWorkspaceState {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly uncertain: boolean;
}
/** Settings facts stay canonical; this owner retains only the current explicit selection and its receipt identity. */
export class NamedWorkspaces {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  private closed = false;
  private pending: Promise<unknown> | undefined;
  private retained: Intent | undefined;
  private intentKind: 'workspace' | 'startup' = 'workspace';
  get isStartupChange(): boolean {
    return this.intentKind === 'startup';
  }
  private state: NamedWorkspaceState = { busy: false, failed: false, uncertain: false };
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly configuration: ConfigurationClientActions,
    private readonly sources: WorkspaceSessionDescriptions,
    private readonly pause: () => Promise<() => void>,
  ) {
    this.off = configuration.subscribe(() => {
      const current = configuration.getSnapshot();
      if (
        current.status === 'ready' &&
        this.retained &&
        current.baseline.generation !== this.retained.generation
      )
        this.retained = undefined;
      this.publish({ ...this.state, uncertain: !!this.retained });
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) throw Error('WORKSPACES_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private facts() {
    const state = this.configuration.getSnapshot();
    if (this.closed || state.status !== 'ready') throw Error('WORKSPACE_SETTINGS_UNAVAILABLE');
    return state.baseline;
  }
  list(): readonly NamedWorkspace[] {
    return this.facts().settings.workspace.namedWorkspaces;
  }
  active(): string | null {
    return this.facts().settings.workspace.activeWorkspaceId;
  }
  private publish(state: NamedWorkspaceState) {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  private admit<T>(
    operation: () => Promise<T>,
    kind: 'workspace' | 'startup' = 'workspace',
  ): Promise<T> {
    if (this.closed || this.pending || this.retained)
      throw Error('WORKSPACE_OPERATION_UNAVAILABLE');
    this.intentKind = kind;
    const task = Promise.resolve().then(operation);
    this.pending = task;
    this.publish({ busy: true, failed: false, uncertain: false });
    void task.then(
      () => {
        this.pending = undefined;
        this.publish({ busy: false, failed: false, uncertain: !!this.retained });
      },
      () => {
        this.pending = undefined;
        this.publish({ busy: false, failed: true, uncertain: !!this.retained });
      },
    );
    return task;
  }
  private check(generation: string) {
    this.lifetime.signal.throwIfAborted();
    if (this.facts().generation !== generation) throw Error('WORKSPACE_GENERATION_RETIRED');
  }
  private async write(input: Intent['input']): Promise<void> {
    const facts = this.facts(),
      intent: Intent = {
        key: crypto.randomUUID(),
        generation: facts.generation,
        version: facts.settings.version,
        input: structuredClone(input),
      };
    this.retained = intent;
    await this.commit(intent);
  }
  private async commit(intent: Intent): Promise<void> {
    this.check(intent.generation);
    const write = this.configuration.setWorkspacePreferences;
    if (!write) throw Error('WORKSPACE_SETTINGS_UNAVAILABLE');
    try {
      const receipt = await write(
        intent.key,
        intent.input,
        '"v' + intent.version + '"',
        intent.generation,
      );
      await this.observed(receipt.cursor, intent.generation);
      if (this.retained === intent) this.retained = undefined;
    } catch (error) {
      const known = remoteErrorOf(error);
      if (
        known?.code === 'configuration/failure' &&
        [
          'invalid-input',
          'precondition-failed',
          'conflict',
          'closed',
          'capacity',
          'receipt-expired',
        ].includes(known.details.reason)
      )
        this.retained = undefined;
      throw error;
    }
  }
  private observed(cursor: number, generation: string): Promise<void> {
    const ready = () => {
      const state = this.configuration.getSnapshot();
      return (
        state.status === 'ready' &&
        state.baseline.generation === generation &&
        state.baseline.cursor >= cursor
      );
    };
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const clean = () => {
        off();
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', abort);
      };
      const update = () => {
        if (settled) return;
        try {
          this.check(generation);
          if (!ready()) return;
          settled = true;
          clean();
          resolve();
        } catch {
          abort();
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clean();
        reject(Error('WORKSPACE_FACTS_UNAVAILABLE'));
      };
      const off = this.configuration.subscribe(update),
        timer = setTimeout(abort, 10000);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  retry(): Promise<void> {
    if (this.closed || this.pending || !this.retained)
      return Promise.reject(Error('WORKSPACE_RETRY_UNAVAILABLE'));
    const intent = this.retained;
    this.pending = this.commit(intent).finally(() => {
      this.pending = undefined;
      this.publish({ busy: false, failed: !!this.retained, uncertain: !!this.retained });
    });
    this.publish({ busy: true, failed: false, uncertain: true });
    return this.pending.then(() => {});
  }
  save(name: string, overwrite?: { id: string; updatedAt: string }): Promise<boolean> {
    return this.admit(async () => {
      const resume = await this.pause();
      try {
        const facts = this.facts(),
          normalized = name.trim(),
          existing = facts.settings.workspace.namedWorkspaces.find(
            (item) =>
              item.name.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0,
          );
        if (
          existing &&
          (overwrite?.id !== existing.id || overwrite.updatedAt !== existing.updatedAt)
        )
          throw Error('WORKSPACE_OVERWRITE_REQUIRED');
        const presentation = workspacePresentationSchema.parse(this.workspace.getPresentation()),
          tabs = this.workspace.getSnapshot().tabs.map((tab) => this.sources.describe(tab));
        if (tabs.length !== presentation.tabs.length) throw Error('WORKSPACE_RETIRED_TAB');
        const now = new Date().toISOString(),
          layout = workspaceLayoutSchema.parse({
            section: ['hosts', 'files', 'tunnels', 'commands', 'ai', 'settings'].includes(
              presentation.section,
            )
              ? presentation.section
              : 'hosts',
            sidebarOpen: presentation.sidebarOpen,
            contentSurface: 'terminal',
            split: presentation.layout?.mode !== 'c1',
            tabs,
            activeTerminalId: presentation.activeTabId,
            secondaryTerminalId: presentation.layout?.paneTabIds[1] ?? null,
            layoutMode: presentation.layout?.mode ?? 'c1',
            paneTerminalIds: presentation.layout?.paneTabIds ?? [],
            focusedPane: presentation.layout?.focusedPane ?? 0,
          });
        const saved = namedWorkspaceSchema.parse({
          id: existing?.id ?? crypto.randomUUID(),
          name: normalized,
          layout,
          presentation,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        const named = existing
          ? facts.settings.workspace.namedWorkspaces.map((item) =>
              item.id === existing.id ? saved : item,
            )
          : [...facts.settings.workspace.namedWorkspaces, saved];
        if (named.length > 20) throw Error('WORKSPACE_CAPACITY');
        await this.write({ namedWorkspaces: named, activeWorkspaceId: saved.id });
        return true;
      } finally {
        resume();
      }
    });
  }
  setStartupSessions(
    value: NonNullable<UpdateSettingsInput['workspace']>['startupSessions'],
  ): Promise<void> {
    return this.admit(() => this.write({ startupSessions: structuredClone(value) }), 'startup');
  }
  remove(id: string, updatedAt: string): Promise<void> {
    return this.admit(async () => {
      const facts = this.facts(),
        selected = facts.settings.workspace.namedWorkspaces.find((item) => item.id === id);
      if (!selected || selected.updatedAt !== updatedAt) throw Error('WORKSPACE_REFERENCE_CHANGED');
      await this.write({
        namedWorkspaces: facts.settings.workspace.namedWorkspaces.filter((item) => item.id !== id),
        activeWorkspaceId:
          facts.settings.workspace.activeWorkspaceId === id
            ? null
            : facts.settings.workspace.activeWorkspaceId,
      });
    });
  }
  load(id: string, caller?: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(caller ? [caller] : [])]);
    return this.admit(async () => {
      const resume = await this.pause(),
        created: string[] = [];
      try {
        const facts = this.facts(),
          selected = facts.settings.workspace.namedWorkspaces.find((item) => item.id === id);
        if (!selected) throw Error('WORKSPACE_NOT_FOUND');
        const captured = namedWorkspaceSchema.parse(structuredClone(selected)),
          source = captured.presentation ?? legacyPresentation(captured),
          generation = facts.generation,
          targetIds = new Set(captured.layout.tabs.map((tab) => tab.id));
        for (const tab of this.workspace.getSnapshot().tabs) {
          signal.throwIfAborted();
          this.check(generation);
          if (!targetIds.has(tab.id)) await this.workspace.closeTab(tab.id);
        }
        const remap = new Map<string, string>();
        for (const tab of captured.layout.tabs) {
          signal.throwIfAborted();
          this.check(generation);
          if (this.workspace.getSnapshot().tabs.some((item) => item.id === tab.id)) {
            remap.set(tab.id, tab.id);
            continue;
          }
          const opened = await this.sources.restore(tab, generation, signal);
          created.push(opened);
          signal.throwIfAborted();
          this.check(generation);
          remap.set(tab.id, opened);
        }
        const map = (value: string | null) => (value ? (remap.get(value) ?? null) : null);
        const presentation: WorkspacePresentation = {
          ...source,
          tabs: source.tabs.map((tab) => ({ ...tab, id: remap.get(tab.id) ?? tab.id })),
          activeTabId: map(source.activeTabId),
          ...(source.layout
            ? { layout: { ...source.layout, paneTabIds: source.layout.paneTabIds.map(map) } }
            : {}),
        };
        this.workspace.replacePresentation(presentation);
        await this.write({ activeWorkspaceId: id });
      } catch (error) {
        if (!this.retained)
          await Promise.allSettled(created.map((id) => this.workspace.closeTab(id)));
        throw error;
      } finally {
        resume();
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    this.off();
    await Promise.allSettled([this.pending]);
    this.listeners.clear();
  }
}
export function legacyPresentation(value: NamedWorkspace): WorkspacePresentation {
  const layout = value.layout,
    ids = new Set(layout.tabs.map((tab) => tab.id)),
    count =
      layout.layoutMode === 'c1'
        ? 1
        : ['c2', 'r2'].includes(layout.layoutMode)
          ? 2
          : layout.layoutMode === 'c2x2'
            ? 4
            : 3;
  const active =
    layout.activeTerminalId && ids.has(layout.activeTerminalId) ? layout.activeTerminalId : null;
  return workspacePresentationSchema.parse({
    section: layout.section,
    sidebarOpen: layout.sidebarOpen,
    activeTabId: active,
    tabs: layout.tabs.map((tab) => ({
      id: tab.id,
      kind:
        tab.kind === 'web'
          ? 'web-session'
          : ['rdp', 'vnc', 'spice'].includes(tab.kind)
            ? 'remote-desktop'
            : 'terminal',
      caption: tab.title,
      title: tab.title,
      pinned: tab.pinned,
      paneIndex: tab.paneIndex,
      ...(tab.tabNumber ? { tabNumber: tab.tabNumber } : {}),
      ...(tab.visual ? { terminalVisual: tab.visual } : {}),
    })),
    layout: {
      mode: layout.layoutMode,
      paneTabIds: Array.from({ length: count }, (_, index) => {
        const id = layout.paneTerminalIds[index] ?? (index === 0 ? active : null);
        return id && ids.has(id) ? id : null;
      }),
      focusedPane: Math.min(count - 1, layout.focusedPane),
    },
  });
}
