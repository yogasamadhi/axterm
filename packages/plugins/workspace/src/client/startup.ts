import type {
  ConfigurationClientActions,
  PersistedTerminalTab,
} from '@axterm/plugin-api/configuration';
import type { CatalogClientActions } from '@axterm/plugin-api/catalog';
import type {
  DesktopStartupUi,
  CatalogStartupUi,
  WorkspaceSessionDescriptions,
} from '@axterm/ui/workspace';
import type { WorkspaceStore } from './store.ts';
import type { NamedWorkspaces } from './named-workspaces.ts';
import type { PresentationStatusStore } from './presentation.ts';
/** One initial UI request. Model changes never restart an admitted command/network sequence. */
export class WorkspaceStartup {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  private pending: Promise<void> | undefined;
  private generation: string | undefined;
  private ioStarted = false;
  private consumed = false;
  private closed = false;
  private state = { busy: false, failed: false };
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly configuration: ConfigurationClientActions,
    private readonly sources: WorkspaceSessionDescriptions,
    private readonly named: NamedWorkspaces,
    private readonly presentation: PresentationStatusStore,
    private readonly catalog: () => CatalogClientActions | undefined,
    private readonly bookmarks: () => CatalogStartupUi | undefined,
    private readonly native: DesktopStartupUi | undefined,
    private readonly events: EventTarget = window,
    private readonly localTitle: (number: number) => string = () => 'Local terminal',
  ) {
    events.addEventListener('pointerdown', this.interact, { capture: true });
    events.addEventListener('keydown', this.interact, { capture: true });
    this.off = configuration.subscribe(this.tick);
    this.tick();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: typeof this.state) {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  private readonly interact = () => {
    if (!this.ioStarted) this.lifetime.abort('interaction');
  };
  private check() {
    this.lifetime.signal.throwIfAborted();
    const current = this.configuration.getSnapshot();
    if (current.status !== 'ready' || current.baseline.generation !== this.generation)
      throw Error('WORKSPACE_STARTUP_RETIRED');
    return current.baseline;
  }
  private readonly tick = () => {
    const state = this.configuration.getSnapshot();
    if (state.status !== 'ready') return;
    if (this.generation && this.generation !== state.baseline.generation) {
      this.lifetime.abort('generation');
      return;
    }
    if (this.consumed || this.closed) return;
    this.consumed = true;
    this.generation = state.baseline.generation;
    this.publish({ busy: true, failed: false });
    this.pending = this.run()
      .then(
        () => this.publish({ busy: false, failed: false }),
        () => this.publish({ busy: false, failed: !this.lifetime.signal.aborted }),
      )
      .finally(() => this.removeInteraction());
  };
  private removeInteraction() {
    this.events.removeEventListener('pointerdown', this.interact, { capture: true });
    this.events.removeEventListener('keydown', this.interact, { capture: true });
  }
  private async waitPresentation() {
    if (this.presentation.getSnapshot() === 'ready') return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        this.lifetime.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const update = () => {
        if (this.presentation.getSnapshot() === 'ready') finish();
      };
      const abort = () => finish(Error('WORKSPACE_STARTUP_UNAVAILABLE'));
      const off = this.presentation.subscribe(update),
        timer = setTimeout(abort, 10000);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.lifetime.signal.aborted) abort();
      else update();
    });
  }
  private async run() {
    await this.waitPresentation();
    const generation = this.check().generation,
      signal = this.lifetime.signal;
    if (this.native && (await this.native.claim(generation, signal)) !== 'configured') return;
    await this.sources.waitFor('local', generation, signal);
    this.check();
    if (this.workspace.getSnapshot().tabs.length) return;
    const settings = this.check().settings,
      startup = settings.workspace.startupSessions;
    if (typeof startup === 'string' && startup) {
      const selected = settings.workspace.namedWorkspaces.find((item) => item.id === startup);
      if (!selected) throw Error('WORKSPACE_STARTUP_REFERENCE_UNAVAILABLE');
      for (const tab of selected.layout.tabs)
        await this.sources.waitFor(tab.kind, generation, signal);
      this.check();
      this.ioStarted = true;
      this.removeInteraction();
      await this.named.load(selected.id, signal);
      return;
    }
    if (Array.isArray(startup) && startup.length) {
      const facts = this.catalog()?.getSnapshot(),
        owner = this.bookmarks();
      if (facts?.status !== 'ready' || facts.baseline.generation !== generation || !owner)
        throw Error('WORKSPACE_STARTUP_CATALOG_UNAVAILABLE');
      const selected = startup.map((id) => {
        const bookmark = facts.baseline.bookmarks.bookmarks.find((item) => item.id === id);
        if (!bookmark) throw Error('WORKSPACE_STARTUP_REFERENCE_UNAVAILABLE');
        return bookmark;
      });
      for (const bookmark of selected) {
        if (bookmark.protocol !== 'ftp')
          await this.sources.waitFor(
            bookmark.protocol as PersistedTerminalTab['kind'],
            generation,
            signal,
          );
      }
      this.check();
      this.ioStarted = true;
      this.removeInteraction();
      for (const bookmark of selected) {
        this.check();
        await owner.openBookmark(bookmark.id, generation, signal);
      }
      return;
    }
    this.ioStarted = true;
    this.removeInteraction();
    await this.sources.restore(
      {
        id: crypto.randomUUID(),
        kind: 'local',
        title: this.localTitle(this.workspace.getSnapshot().tabs.length + 1),
        pinned: false,
        paneIndex: 0,
        ...(settings.terminal.defaultProfileId
          ? { profileId: settings.terminal.defaultProfileId }
          : {}),
      },
      generation,
      signal,
    );
  }
  async close() {
    this.closed = true;
    this.lifetime.abort('closed');
    this.off();
    this.removeInteraction();
    await this.pending;
    this.listeners.clear();
  }
}
