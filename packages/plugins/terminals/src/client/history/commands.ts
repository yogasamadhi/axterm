import { remoteErrorOf } from '@axterm/plugin-api';
import type { CommandHistoryItem } from '@axterm/plugin-api/terminals';
import type { TerminalDraftUi } from '@axterm/ui/workspace';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalFactsModel } from '../facts.ts';
interface CommandState {
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failed: boolean;
  readonly completed: number;
}
type Facts = Pick<
  TerminalFactsModel,
  'getSnapshot' | 'deleteCommandHistory' | 'clearCommandHistory'
>;
/** Terminal facts and Configuration preferences keep separate owners and captured preconditions. */
export class TerminalHistoryCommands {
  private readonly lifetime = new AbortController();
  private readonly transient = new Set<Promise<unknown>>();
  private state: CommandState = { busy: false, uncertain: false, failed: false, completed: 0 };
  private readonly listeners = new Set<() => void>();
  private retained: { generation: string; invoke: () => Promise<unknown> } | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Facts,
    private readonly configuration: ConfigurationClientActions,
    private readonly drafts: TerminalDraftUi,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  remove(item: CommandHistoryItem) {
    const id = item.id,
      version = item.version,
      generation = this.readyGeneration();
    return this.fact((key) =>
      this.model.deleteCommandHistory(key, id, `"v${version}"`, generation),
    );
  }
  clear() {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_HISTORY_NOT_READY');
    const etag = state.baseline.history.etag,
      generation = state.baseline.generation;
    return this.fact((key) => this.model.clearCommandHistory(key, etag, generation));
  }
  setEnabled(enabled: boolean) {
    const settings = this.configuration.getSnapshot(),
      generation = this.readyGeneration();
    if (
      settings.status !== 'ready' ||
      settings.baseline.generation !== generation ||
      !this.configuration.setCommandHistoryEnabled
    )
      throw Error('TERMINAL_HISTORY_SETTINGS_NOT_READY');
    const etag = `"v${settings.baseline.settings.version}"`;
    return this.fact((key) => this.configuration.setCommandHistoryEnabled!(key, enabled, etag));
  }
  insert(id: string, item: CommandHistoryItem): Promise<void> {
    const command = this.assertItem(item).command;
    const generation = this.readyGeneration();
    return this.trackTransient(() => {
      if (this.readyGeneration() !== generation) throw Error('TERMINAL_HISTORY_GENERATION_CHANGED');
      return this.drafts.insertDraft(id, command, this.lifetime.signal);
    });
  }
  copy(item: CommandHistoryItem): Promise<void> {
    const command = this.assertItem(item).command;
    return this.trackTransient(() => navigator.clipboard.writeText(command));
  }
  private assertItem(item: CommandHistoryItem): CommandHistoryItem {
    this.readyGeneration();
    const facts = this.model.getSnapshot(),
      settings = this.configuration.getSnapshot();
    if (
      this.closing ||
      facts.status !== 'ready' ||
      settings.status !== 'ready' ||
      !settings.baseline.settings.privacy.commandHistoryEnabled ||
      settings.baseline.generation !== facts.baseline.generation
    )
      throw Error('TERMINAL_HISTORY_ITEM_UNAVAILABLE');
    const accepted = facts.baseline.history.items.find(
      (value) => value.id === item.id && value.version === item.version,
    );
    if (!accepted) throw Error('TERMINAL_HISTORY_ITEM_UNAVAILABLE');
    return accepted;
  }
  private trackTransient(invoke: () => Promise<void>): Promise<void> {
    if (this.closing || this.transient.size >= 8) throw Error('TERMINAL_HISTORY_BUSY');
    const task = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted();
      return invoke();
    });
    this.transient.add(task);
    void task.then(
      () => this.transient.delete(task),
      () => this.transient.delete(task),
    );
    return task;
  }
  private readyGeneration(): string {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_HISTORY_NOT_READY');
    return state.baseline.generation;
  }
  retry() {
    if (this.closing || this.pending || !this.retained)
      throw new Error('TERMINAL_HISTORY_NOT_UNCERTAIN');
    return this.run();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.transient]);
      await this.pending;
      this.listeners.clear();
      const facts = this.model.getSnapshot();
      if (
        this.retained &&
        (facts.status !== 'ready' || facts.baseline.generation === this.retained.generation)
      )
        throw new Error('TERMINAL_HISTORY_DRAIN_UNCERTAIN');
      this.retained = undefined;
    })());
  }
  private fact(invoke: (key: string) => Promise<unknown>) {
    if (this.closing || this.pending || this.retained) throw new Error('TERMINAL_HISTORY_BUSY');
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') throw new Error('TERMINAL_HISTORY_NOT_READY');
    const key = crypto.randomUUID();
    this.retained = { generation: facts.baseline.generation, invoke: () => invoke(key) };
    return this.run();
  }
  private run() {
    const retained = this.retained!;
    const facts = this.model.getSnapshot();
    if (facts.status === 'ready' && facts.baseline.generation !== retained.generation) {
      this.retained = undefined;
      this.publish({ ...this.state, busy: false, uncertain: false, failed: true });
      return Promise.resolve();
    }
    if (facts.status !== 'ready') {
      this.publish({ ...this.state, uncertain: true });
      return Promise.resolve();
    }
    this.publish({ ...this.state, busy: true, failed: false });
    const task = Promise.resolve()
      .then(async () => {
        const current = this.model.getSnapshot();
        if (current.status !== 'ready') throw new Error('TERMINAL_HISTORY_NOT_READY');
        if (current.baseline.generation !== retained.generation) {
          this.retained = undefined;
          throw new Error('TERMINAL_HISTORY_GENERATION_CHANGED');
        }
        await retained.invoke();
        const after = this.model.getSnapshot();
        if (after.status === 'ready' && after.baseline.generation !== retained.generation) {
          this.retained = undefined;
          throw new Error('TERMINAL_HISTORY_GENERATION_CHANGED');
        }
      })
      .then(
        () => {
          this.retained = undefined;
          this.publish({
            busy: false,
            uncertain: false,
            failed: false,
            completed: this.state.completed + 1,
          });
        },
        (error) => {
          const marked = remoteErrorOf(error);
          const definite =
            (marked?.code === 'terminals/failure' || marked?.code === 'configuration/failure') &&
            [
              'invalid-input',
              'not-found',
              'closed',
              'capacity',
              'conflict',
              'stale',
              'precondition-required',
              'precondition-failed',
            ].includes(marked.details.reason);
          if (definite) this.retained = undefined;
          this.publish({ ...this.state, busy: false, uncertain: !!this.retained, failed: true });
        },
      );
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => {});
    return task;
  }
  private publish(state: CommandState) {
    this.state = Object.freeze(state);
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('TERMINAL_HISTORY_UI_OBSERVER_FAILED');
        }
      }
  }
}
