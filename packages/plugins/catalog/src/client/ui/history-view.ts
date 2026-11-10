import {
  CONNECTION_HISTORY_MAX_ITEMS,
  type ConnectionHistoryPage,
  type ConnectionHistorySort,
} from '@axterm/plugin-api/catalog';
import type { CatalogModel } from '../index.ts';
type Model = Pick<CatalogModel, 'getSnapshot' | 'subscribe' | 'listConnectionHistory'>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface HistoryViewState {
  readonly sort: ConnectionHistorySort;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly page?: ConnectionHistoryPage;
}
/** One bounded, accepted-revision-aware selected view; no timer, cache or mutation replay. */
export class HistoryView {
  private state: HistoryViewState = { sort: 'recent', busy: false, failed: false };
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;
  private identity: string | undefined;
  private revision = 0;
  private pending: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  constructor(private readonly model: Model) {
    this.stop = model.subscribe(() => this.observe());
    this.observe();
  }
  getSnapshot = (): HistoryViewState => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  sort(sort: ConnectionHistorySort): void {
    if (this.closed || this.state.sort === sort) return;
    this.revision++;
    this.publish({ sort, busy: !!this.pending, failed: false });
    this.request(false);
  }
  retry(): void {
    if (!this.closed) this.request(false);
  }
  more(): void {
    if (!this.closed && this.state.page?.nextCursor && !this.pending) this.request(true);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.stop();
    await this.pending;
    this.listeners.clear();
  }
  private observe(): void {
    if (this.closed) return;
    const state = this.model.getSnapshot();
    const identity =
      state.status === 'ready'
        ? state.baseline.generation + ':' + state.baseline.history.etag
        : undefined;
    if (identity === this.identity) return;
    this.identity = identity;
    this.revision++;
    this.publish({ sort: this.state.sort, busy: !!this.pending, failed: false });
    if (identity) this.request(false);
  }
  private request(more: boolean): void {
    if (!this.identity || this.closed) return;
    if (this.pending) {
      this.dirty = true;
      return;
    }
    const revision = this.revision;
    const identity = this.identity;
    const previous = more ? this.state.page : undefined;
    const sort = this.state.sort;
    this.publish({ ...this.state, busy: true, failed: false });
    const task = Promise.resolve().then(async () => {
      try {
        const page = await this.model.listConnectionHistory(
          identity.slice(0, identity.indexOf(':')),
          { sort, limit: 25, ...(previous?.nextCursor ? { cursor: previous.nextCursor } : {}) },
        );
        if (this.closed || revision !== this.revision || identity !== this.identity) return;
        if (identity !== this.modelIdentity() || (previous && previous.etag !== page.etag)) {
          this.dirty = true;
          return;
        }
        const items = previous ? [...previous.items, ...page.items] : page.items;
        if (
          items.length > CONNECTION_HISTORY_MAX_ITEMS ||
          new Set(items.map((item) => item.id)).size !== items.length
        )
          throw new Error('HISTORY_PAGE_INVALID');
        this.publish({ sort, busy: false, failed: false, page: freeze({ ...page, items }) });
      } catch {
        if (!this.closed && revision === this.revision)
          this.publish({ ...this.state, busy: false, failed: true });
      }
    });
    this.pending = task;
    void task.finally(() => {
      this.pending = undefined;
      if (!this.closed && this.dirty) {
        this.dirty = false;
        this.request(false);
      } else if (!this.closed && this.state.busy) this.publish({ ...this.state, busy: false });
    });
  }
  private modelIdentity(): string | undefined {
    const state = this.model.getSnapshot();
    return state.status === 'ready'
      ? state.baseline.generation + ':' + state.baseline.history.etag
      : undefined;
  }
  private publish(state: HistoryViewState): void {
    this.state = Object.freeze(state);
    for (const fn of [...this.listeners]) fn();
  }
}
