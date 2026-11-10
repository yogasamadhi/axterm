import { remoteErrorOf } from '@axterm/plugin-api';
import type { ConnectionHistoryItem } from '@axterm/plugin-api/catalog';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { ConnectionWorkspaceUi } from '@axterm/ui/workspace';
import type { CatalogModel } from '../index.ts';
type Model = Pick<
  CatalogModel,
  | 'getSnapshot'
  | 'promoteConnectionHistoryToBookmark'
  | 'deleteConnectionHistory'
  | 'clearConnectionHistory'
>;
export type HistoryActionState = {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly uncertain: boolean;
};
export function historyReconnectRequirement(item: ConnectionHistoryItem) {
  if (item.hostId) return 'direct';
  if (item.authType === 'password' || item.authType === 'keyboardInteractive')
    return 'one-time-secret';
  if (item.authType === 'privateKey') return 'configure-private-key';
  return 'direct';
}
/** Own fact-command identity separately from network admission and transient form secrets. */
export class HistoryActions {
  private state: HistoryActionState = { busy: false, failed: false, uncertain: false };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<boolean> | undefined;
  private retained: { generation: string; invoke(): Promise<unknown> } | undefined;
  private readonly lifetime = new AbortController();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Model,
    private readonly settings: Pick<
      ConfigurationClientActions,
      'getSnapshot' | 'setConnectionHistoryEnabled'
    >,
    private readonly connections: ConnectionWorkspaceUi,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  dismiss(): void {
    this.publish({ ...this.state, failed: false });
  }
  promote(item: ConnectionHistoryItem): Promise<boolean> {
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return this.unavailable();
    const key = crypto.randomUUID(),
      id = item.id,
      version = '"v' + item.version + '"';
    const tree = facts.baseline.bookmarks.etag;
    const input = { title: item.name };
    return this.fact(() =>
      this.model.promoteConnectionHistoryToBookmark(key, id, input, version, tree),
    );
  }
  remove(item: ConnectionHistoryItem): Promise<boolean> {
    const key = crypto.randomUUID(),
      id = item.id,
      version = '"v' + item.version + '"';
    return this.fact(() => this.model.deleteConnectionHistory(key, id, version));
  }
  clear(etag: string): Promise<boolean> {
    const key = crypto.randomUUID();
    return this.fact(() => this.model.clearConnectionHistory(key, etag));
  }
  enabled(enabled: boolean): Promise<boolean> {
    const settings = this.settings.getSnapshot();
    const facts = this.model.getSnapshot();
    if (
      settings.status !== 'ready' ||
      facts.status !== 'ready' ||
      settings.baseline.generation !== facts.baseline.generation
    )
      return this.unavailable();
    const key = crypto.randomUUID(),
      version = '"v' + settings.baseline.settings.version + '"';
    return this.fact(() => this.settings.setConnectionHistoryEnabled(key, enabled, version));
  }
  retry(): Promise<boolean> {
    if (!this.retained || this.pending || this.closed) return Promise.resolve(false);
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return Promise.resolve(false);
    if (state.baseline.generation !== this.retained.generation) {
      this.retained = undefined;
      this.publish({ busy: false, failed: true, uncertain: false });
      return Promise.resolve(false);
    }
    return this.invoke(this.retained.invoke, true);
  }
  connect(item: ConnectionHistoryItem, secret?: string): Promise<boolean> {
    if (this.closed || this.pending || this.retained) return Promise.resolve(false);
    const id = item.id,
      version = '"v' + item.version + '"';
    return this.invoke(
      () =>
        this.connections.openHistory(
          id,
          secret === undefined ? {} : { temporarySecret: secret },
          version,
          { signal: this.lifetime.signal },
        ),
      false,
    );
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.lifetime.abort();
      await this.pending;
      const state = this.model.getSnapshot();
      this.listeners.clear();
      if (
        this.retained &&
        !(state.status === 'ready' && state.baseline.generation !== this.retained.generation)
      )
        throw new Error('HISTORY_COMMAND_DRAIN_UNCERTAIN');
      this.retained = undefined;
      this.listeners.clear();
    })());
  }
  private unavailable(): Promise<boolean> {
    this.publish({ ...this.state, failed: true });
    return Promise.resolve(false);
  }
  private fact(invoke: () => Promise<unknown>): Promise<boolean> {
    if (this.closed || this.pending || this.retained) return Promise.resolve(false);
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') return this.unavailable();
    this.retained = { generation: facts.baseline.generation, invoke };
    return this.invoke(invoke, true);
  }
  private invoke(invoke: () => Promise<unknown>, fact: boolean): Promise<boolean> {
    this.publish({ busy: true, failed: false, uncertain: false });
    const task = Promise.resolve()
      .then(invoke)
      .then(
        () => {
          if (fact) this.retained = undefined;
          this.publish({ busy: false, failed: false, uncertain: false });
          return true;
        },
        (error) => {
          const marked = remoteErrorOf(error);
          const definite =
            (marked?.code === 'catalog/failure' || marked?.code === 'configuration/failure') &&
            [
              'invalid-input',
              'not-found',
              'capacity',
              'closed',
              'conflict',
              'stale',
              'precondition-required',
              'precondition-failed',
            ].includes(marked.details.reason);
          if (fact && definite) this.retained = undefined;
          this.publish({ busy: false, failed: true, uncertain: !!this.retained });
          return false;
        },
      );
    this.pending = task;
    void task.finally(() => {
      this.pending = undefined;
    });
    return task;
  }
  private publish(state: HistoryActionState): void {
    this.state = Object.freeze(state);
    if (!this.closed) for (const fn of [...this.listeners]) fn();
  }
}
