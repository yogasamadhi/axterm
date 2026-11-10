import { randomUUID } from 'node:crypto';
import type { CatalogQueries, NativeWebViews } from '@axterm/plugin-api/host';
import {
  nativeWebViewStateSchema,
  webSessionSchema,
  type CreateWebSession,
  type WebSession,
  type NativeWebViewState,
  type NativeWebViewPresentation,
  type NativeWebViewAction,
  type NativeWebViewAuthResponse,
} from '@axterm/plugin-api/remote-desktop';
import { failure } from './sessions.ts';
export type WebSessionChange =
  { type: 'upsert'; session: WebSession } | { type: 'remove'; id: string };
interface Managed {
  metadata: WebSession;
  opening?: Promise<WebSession>;
  closing?: Promise<void>;
}
/** Host fact owner. Exactly one bounded, sequential native observation loop; no UI polling cache. */
export class WebSessions {
  private readonly records = new Map<string, Managed>();
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly listeners = new Set<(windowId: string, change: WebSessionChange) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing?: Promise<void>;
  constructor(
    private readonly catalog: Pick<CatalogQueries, 'getBookmark'>,
    private readonly native: NativeWebViews | undefined,
  ) {}
  list(windowId: string): WebSession[] {
    return [...this.records.values()]
      .filter((r) => r.metadata.windowId === windowId)
      .map((r) => structuredClone(r.metadata));
  }
  get(id: string, windowId?: string): WebSession {
    return structuredClone(this.require(id, windowId).metadata);
  }
  subscribe(listener: (windowId: string, change: WebSessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  create(
    input: CreateWebSession,
    signal: AbortSignal,
    allocated: (id: string) => void,
  ): Promise<WebSession> {
    signal.throwIfAborted();
    if (this.closing) throw failure('closed');
    if (!this.native) throw failure('unavailable');
    if (this.records.size >= 8) throw failure('capacity');
    const bookmark = this.catalog.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'web' || !bookmark.web) throw failure('invalid-input');
    const id = randomUUID(),
      now = new Date().toISOString(),
      web = bookmark.web;
    const record: Managed = {
      metadata: webSessionSchema.parse({
        id,
        windowId: input.windowId,
        bookmarkId: bookmark.id,
        title: bookmark.title,
        description: bookmark.description,
        url: web.url,
        currentUrl: web.url,
        userAgent: web.userAgent,
        hideAddressBar: web.hideAddressBar,
        state: 'created',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        visible: false,
        createdAt: now,
        updatedAt: now,
      }),
    };
    this.records.set(id, record);
    try {
      allocated(id);
    } catch (error) {
      this.records.delete(id);
      throw error;
    }
    this.publish(record, { type: 'upsert', session: record.metadata });
    const task = Promise.resolve().then(async () => {
      const owned = AbortSignal.any([this.lifetime.signal, signal]);
      try {
        owned.throwIfAborted();
        const state = await this.native!.create(
          { id, windowId: input.windowId, url: web.url, userAgent: web.userAgent },
          owned,
        );
        owned.throwIfAborted();
        this.update(record, state);
        return this.get(id, input.windowId);
      } catch {
        // The exact id was bound before native dispatch. Keep it if native cleanup is uncertain.
        try {
          await this.native!.close(input.windowId, id, new AbortController().signal);
          this.records.delete(id);
          this.publish(record, { type: 'remove', id });
        } catch {
          record.metadata = {
            ...record.metadata,
            state: 'failed',
            errorCode: 'WEB_VIEW_CLEANUP_UNCERTAIN',
            visible: false,
          };
          this.publish(record, { type: 'upsert', session: record.metadata });
        }
        throw failure('unavailable');
      } finally {
        delete record.opening;
        this.schedule();
      }
    });
    record.opening = task;
    return this.track(task);
  }
  present(
    id: string,
    windowId: string,
    input: NativeWebViewPresentation,
    signal: AbortSignal,
  ): Promise<WebSession> {
    return this.change(id, windowId, signal, (native, owned) =>
      native.present(windowId, id, input, owned),
    );
  }
  perform(
    id: string,
    windowId: string,
    input: NativeWebViewAction,
    signal: AbortSignal,
  ): Promise<WebSession> {
    return this.change(id, windowId, signal, (native, owned) =>
      native.perform(windowId, id, input, owned),
    );
  }
  authenticate(
    id: string,
    windowId: string,
    input: NativeWebViewAuthResponse,
    signal: AbortSignal,
  ): Promise<WebSession> {
    return this.change(id, windowId, signal, (native, owned) =>
      native.authenticate(windowId, id, input, owned),
    );
  }
  closeSession(id: string, windowId: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    this.require(id, windowId);
    if (record.closing) return record.closing;
    const task = (async () => {
      await record.opening?.catch(() => {});
      if (!this.records.has(id)) return;
      await this.native!.close(windowId, id, new AbortController().signal);
      this.records.delete(id);
      this.publish(record, { type: 'remove', id });
    })();
    record.closing = task;
    void task.catch(() => {
      if (record.closing === task) delete record.closing;
    });
    return this.track(task);
  }
  resourceCount(): number {
    return this.records.size + this.tasks.size;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      if (this.timer) clearTimeout(this.timer);
      await Promise.allSettled([...this.tasks]);
      const results = await Promise.allSettled(
        [...this.records.values()].map((r) =>
          this.closeSession(r.metadata.id, r.metadata.windowId),
        ),
      );
      this.listeners.clear();
      if (results.some((r) => r.status === 'rejected') || this.records.size)
        throw failure('unavailable');
    })());
  }
  private change(
    id: string,
    windowId: string,
    signal: AbortSignal,
    apply: (native: NativeWebViews, signal: AbortSignal) => Promise<NativeWebViewState>,
  ): Promise<WebSession> {
    if (this.closing) throw failure('closed');
    const record = this.require(id, windowId);
    if (record.closing || record.opening || !this.native) throw failure('unavailable');
    return this.track(
      (async () => {
        const state = await apply(this.native!, AbortSignal.any([signal, this.lifetime.signal]));
        if (this.records.get(id) === record && !record.closing) this.update(record, state);
        return this.get(id, windowId);
      })(),
    );
  }
  private require(id: string, windowId?: string): Managed {
    const record = this.records.get(id);
    if (!record) throw failure('not-found');
    if (windowId !== undefined && record.metadata.windowId !== windowId) throw failure('conflict');
    return record;
  }
  private update(record: Managed, input: NativeWebViewState): void {
    const state = nativeWebViewStateSchema.parse(input);
    if (state.id !== record.metadata.id) throw failure('conflict');
    const {
      blockedUrl: _blocked,
      errorCode: _error,
      authChallenge: _auth,
      ...base
    } = record.metadata;
    const next = webSessionSchema.parse({
      ...base,
      ...state,
      title: record.metadata.title,
      url: record.metadata.url,
      currentUrl: state.url,
      updatedAt: record.metadata.updatedAt,
    });
    if (JSON.stringify(next) === JSON.stringify(record.metadata)) return;
    record.metadata = { ...next, updatedAt: new Date().toISOString() };
    this.publish(record, { type: 'upsert', session: record.metadata });
  }
  private publish(record: Managed, change: WebSessionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(record.metadata.windowId, structuredClone(change));
      } catch {
        console.warn('WEB_SESSION_OBSERVER_FAILED');
      }
    }
  }
  private schedule(): void {
    if (this.closing || this.timer || !this.records.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.track(this.poll()).finally(() => this.schedule());
    }, 750);
    this.timer.unref();
  }
  private async poll(): Promise<void> {
    for (const record of this.records.values()) {
      if (this.lifetime.signal.aborted) return;
      if (record.opening || record.closing) continue;
      try {
        this.update(
          record,
          await this.native!.state(
            record.metadata.windowId,
            record.metadata.id,
            this.lifetime.signal,
          ),
        );
      } catch (error) {
        if (!this.lifetime.signal.aborted) {
          const code =
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
          if (code === 'NOT_FOUND' || code === 'FORBIDDEN' || code === 'CLOSED') {
            try {
              await this.closeSession(record.metadata.id, record.metadata.windowId);
              continue;
            } catch {
              /* Keep ownership when native destruction is uncertain. */
            }
          }
          record.metadata = {
            ...record.metadata,
            state: 'failed',
            visible: false,
            loading: false,
            errorCode: 'WEB_VIEW_UNAVAILABLE',
          };
          this.publish(record, { type: 'upsert', session: record.metadata });
        }
      }
    }
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    const done = () => this.tasks.delete(task);
    void task.then(done, done);
    return task;
  }
}
