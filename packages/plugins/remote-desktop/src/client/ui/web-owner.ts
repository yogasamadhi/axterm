import { remoteErrorOf } from '@axterm/plugin-api';
import type { WebSession, CreateWebSession } from '@axterm/plugin-api/remote-desktop';
import type { WorkspaceUi, WorkspaceTabRegistration } from '@axterm/ui/workspace';
import type { WebSessionModel } from '../web-model.ts';
interface ManagedSurface {
  dispose(): Promise<void>;
}
interface RecordOwner {
  readonly generation: string;
  readonly id: string;
  readonly tab: WorkspaceTabRegistration;
  readonly surfaces: Set<ManagedSurface>;
  closing?: Promise<void>;
}
/** Owns UI intent and renderer lifetime, never a second metadata projection or a byte queue. */
export class WebSessionWorkspace {
  private readonly lifetime = new AbortController();
  private readonly records = new Map<string, RecordOwner>();
  private readonly pending = new Set<Promise<string>>();
  private readonly cleanup = new Set<Promise<void>>();
  private readonly uncertain = new Map<string, string>();
  private readonly rollback = new Map<string, string>();
  private closing: Promise<void> | undefined;
  private reconciling: Promise<void> | undefined;
  private readonly unsubscribe: () => void;
  private snapshot = { uncertain: false, failed: false };
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly model: Pick<
      WebSessionModel,
      'getSnapshot' | 'subscribe' | 'create' | 'close' | 'getCommandOutcome'
    >,
    private readonly workspace: WorkspaceUi,
  ) {
    this.unsubscribe = model.subscribe(() => {
      const state = model.getSnapshot();
      if (state.status !== 'ready') return;
      for (const record of this.records.values())
        if (
          record.generation !== state.baseline.generation ||
          !state.baseline.sessions.some((value) => value.id === record.id)
        )
          void this.closeView(record.id).catch(() => this.publish(true));
    });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(input: Pick<CreateWebSession, 'bookmarkId'>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.closing || this.pending.size + this.uncertain.size + this.rollback.size >= 8)
      throw Error('WEB_SESSION_WORKSPACE_CAPACITY');
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready') throw Error('WEB_SESSION_WORKSPACE_UNAVAILABLE');
    const generation = initial.baseline.generation,
      key = crypto.randomUUID(),
      request = structuredClone(input),
      owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      this.assertGeneration(generation);
      let session: WebSession | undefined;
      try {
        session = await this.model.create(request, key, owned);
      } catch (error) {
        const marked = remoteErrorOf(error);
        if (
          marked?.code !== 'remoteDesktop/failure' ||
          !['invalid-input', 'conflict', 'closed', 'capacity', 'not-found'].includes(
            marked.details.reason,
          )
        ) {
          this.uncertain.set(key, generation);
          await this.reconcile(key, generation).catch(() => {});
          this.publish(true);
        }
      }
      // Normalize after reconciliation without retaining a credential-bearing error cause.
      if (!session) throw Error('WEB_SESSION_ADMISSION_FAILED');
      this.rollback.set(session.id, generation);
      try {
        await this.waitMetadata(session.id, generation, owned);
        owned.throwIfAborted();
        this.assertGeneration(generation);
        const tab = this.workspace.registerTab(
          { id: session.id, kind: 'web-session', title: session.title, icon: 'web' },
          () => this.closeView(session.id),
        );
        this.records.set(session.id, { id: session.id, generation, tab, surfaces: new Set() });
        tab.activate();
        this.rollback.delete(session.id);
        return session.id;
      } catch {
        if (this.records.has(session.id)) await this.closeView(session.id);
        else await this.release(session.id, generation);
        throw Error('WEB_SESSION_VIEW_FAILED');
      }
    });
    this.pending.add(task);
    const settled = () => this.pending.delete(task);
    void task.then(settled, settled);
    return task;
  }
  async reconnect(id: string): Promise<string> {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('WEB_SESSION_NOT_READY');
    const session = state.baseline.sessions.find((value) => value.id === id);
    if (!session || !this.records.has(id)) throw Error('WEB_SESSION_VIEW_MISSING');
    const input = { bookmarkId: session.bookmarkId };
    await this.closeView(id);
    return this.open(input);
  }
  retryCleanup(): Promise<void> {
    return (this.reconciling ??= (async () => {
      for (const [key, generation] of this.uncertain) await this.reconcile(key, generation);
      for (const [id, generation] of this.rollback) await this.release(id, generation);
      this.publish(false);
    })().finally(() => {
      this.reconciling = undefined;
    }));
  }
  closeView(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    if (record.closing) return record.closing;
    const task = (async () => {
      const results = await Promise.allSettled(
        [...record.surfaces].map((surface) => surface.dispose()),
      );
      if (results.some((value) => value.status === 'rejected'))
        throw Error('WEB_SESSION_RENDERER_UNDRAINED');
      record.surfaces.clear();
      await this.release(id, record.generation);
      record.tab.dispose();
      this.records.delete(id);
    })();
    record.closing = task;
    void task.catch(() => {
      if (record.closing === task) delete record.closing;
    });
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.unsubscribe();
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(
        [...this.records.keys()].map((id) => this.closeView(id)),
      );
      await Promise.allSettled([...this.cleanup]);
      const final = await Promise.allSettled([this.retryCleanup()]);
      this.listeners.clear();
      if (
        final.some((value) => value.status === 'rejected') ||
        results.some((value) => value.status === 'rejected') ||
        this.records.size ||
        this.uncertain.size ||
        this.rollback.size
      )
        throw Error('WEB_SESSION_WORKSPACE_UNDRAINED');
    })());
  }
  attach(id: string, surface: ManagedSurface): () => void {
    const record = this.records.get(id);
    if (!record || record.closing || this.closing) throw Error('WEB_SESSION_SURFACE_RETIRED');
    record.surfaces.add(surface);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const task = surface.dispose().then(() => {
        record.surfaces.delete(surface);
      });
      this.cleanup.add(task);
      void task.then(
        () => this.cleanup.delete(task),
        () => {
          this.cleanup.delete(task);
          this.publish(true);
        },
      );
    };
  }
  private async release(id: string, generation: string) {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('WEB_SESSION_CLEANUP_UNCERTAIN');
    if (state.baseline.generation === generation) await this.model.close(id, generation);
    this.rollback.delete(id);
  }
  private async reconcile(key: string, generation: string) {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('WEB_SESSION_OUTCOME_UNCERTAIN');
    if (state.baseline.generation !== generation) {
      this.uncertain.delete(key);
      return;
    }
    const result = await this.model.getCommandOutcome(generation, key);
    if (result.status === 'accepted') await this.release(result.id, generation);
    else if (result.status !== 'rejected') throw Error('WEB_SESSION_OUTCOME_UNCERTAIN');
    this.uncertain.delete(key);
  }
  private assertGeneration(generation: string) {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready' || state.baseline.generation !== generation)
      throw Error('WEB_SESSION_GENERATION_RETIRED');
  }
  private waitMetadata(id: string, generation: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const state = this.model.getSnapshot();
        if (state.status === 'error') finish(Error('WEB_SESSION_FACTS_UNAVAILABLE'));
        else if (state.status === 'ready') {
          if (state.baseline.generation !== generation)
            finish(Error('WEB_SESSION_GENERATION_RETIRED'));
          else if (state.baseline.sessions.some((value) => value.id === id)) finish();
        }
      };
      const abort = () => finish(Error('WEB_SESSION_VIEW_CANCELED'));
      const timer = setTimeout(() => finish(Error('WEB_SESSION_FACTS_TIMEOUT')), 10000);
      try {
        off = this.model.subscribe(check);
        if (done) {
          off();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      } catch {
        finish(Error('WEB_SESSION_FACTS_UNAVAILABLE'));
      }
    });
  }
  private publish(failed: boolean) {
    this.snapshot = Object.freeze({
      uncertain: this.uncertain.size > 0 || this.rollback.size > 0,
      failed,
    });
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('WEB_SESSION_UI_OBSERVER_FAILED');
        }
      }
  }
}
