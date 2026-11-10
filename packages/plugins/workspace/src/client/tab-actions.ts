import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalSessionUi, WorkspaceSessionDescriptions } from '@axterm/ui/workspace';
import type { WorkspaceStore } from './store.ts';
/** Captured UI intent; session admission and actual cancellation stay in their owners. */
export class WorkspaceTabActions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Map<
    string,
    { generation: string; controller: AbortController; task: Promise<void> }
  >();
  private readonly off: () => void;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly configuration: ConfigurationClientActions,
    private readonly sources: WorkspaceSessionDescriptions,
    private readonly terminal: () => TerminalSessionUi | undefined,
  ) {
    this.off = configuration.subscribe(() => {
      const state = configuration.getSnapshot();
      for (const entry of this.pending.values())
        if (state.status !== 'ready' || state.baseline.generation !== entry.generation)
          entry.controller.abort();
    });
  }
  duplicate(id: string): Promise<void> {
    if (this.closing || this.pending.has(id) || this.pending.size >= 8)
      throw Error('TAB_ACTION_BUSY');
    const facts = this.configuration.getSnapshot(),
      tab = this.workspace.getSnapshot().tabs.find((value) => value.id === id);
    if (facts.status !== 'ready' || !tab) throw Error('TAB_ACTION_UNAVAILABLE');
    const generation = facts.baseline.generation,
      controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const check = () => {
      signal.throwIfAborted();
      const current = this.configuration.getSnapshot();
      if (
        current.status !== 'ready' ||
        current.baseline.generation !== generation ||
        !this.workspace.getSnapshot().tabs.some((value) => value.id === id)
      )
        throw Error('TAB_ACTION_RETIRED');
    };
    const task = Promise.resolve().then(async () => {
      check();
      if (tab.kind === 'terminal') {
        const owner = this.terminal();
        if (!owner) throw Error('TAB_SESSION_OWNER_UNAVAILABLE');
        await owner.duplicate(id, false, signal);
        return;
      }
      const description = this.sources.describe(tab);
      check();
      const created = await this.sources.restore(
        { ...description, id: crypto.randomUUID() },
        generation,
        signal,
      );
      check();
      this.workspace.arrange.moveToPane(created, tab.paneIndex ?? 0);
      if (tab.pinned) this.workspace.arrange.pinTab(created);
      this.workspace.arrange.renameTab(created, tab.title);
      this.workspace.arrange.moveTab(created, id, true);
      this.workspace.selectTab(created);
    });
    this.pending.set(id, { generation, controller, task });
    const release = () => {
      if (this.pending.get(id)?.task === task) this.pending.delete(id);
    };
    void task.then(release, release);
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.off();
      await Promise.allSettled([...this.pending.values()].map((value) => value.task));
      this.pending.clear();
    })());
  }
}
