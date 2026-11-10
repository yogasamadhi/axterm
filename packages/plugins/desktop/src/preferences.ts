import { randomUUID } from 'node:crypto';
import { RemoteError } from '@axterm/plugin-api';
import { desktopWindowPreferencesPatchSchema } from '@axterm/plugin-api/desktop';
import type {
  DesktopWindowBaseline,
  DesktopWindowUpdate,
  DesktopWindowPreferencesPatch,
  DesktopWindowReceipt,
  NativeDesktopWindows,
  NativeDesktopWindowState,
} from '@axterm/plugin-api/desktop';
import type { DesktopPreferencesStore } from './preferences-store.ts';

/** Durable facts and native application have distinct outcomes and deterministic owners. */
export class DesktopPreferences {
  private readonly lifetime = new AbortController();
  private nativeState: NativeDesktopWindowState | null = null;
  private application: DesktopWindowBaseline['application'] = 'unavailable';
  private appliedVersion = -1;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private polling: Promise<void> | undefined;
  private initializing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly followers = new Set<{ stop(): void; done(): Promise<unknown> }>();
  constructor(
    private readonly store: DesktopPreferencesStore,
    private readonly generation: string,
    private readonly native: NativeDesktopWindows | undefined,
  ) {}
  initialize(): Promise<void> {
    return (this.initializing ??= this.admit(async () => {
      this.store.read();
      if (!this.native) return;
      // Startup must obtain the accepted snapshot before creating the first normal Shell window.
      await this.reconcile();
      this.polling = this.poll();
      void this.polling.catch(() => {
        this.application = 'failed';
      });
    }));
  }
  snapshot(): DesktopWindowBaseline {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    return {
      type: 'baseline',
      generation: this.generation,
      cursor: this.store.domain.cursor(),
      record: this.store.read(),
      native: this.nativeState,
      application: this.application,
    };
  }
  update(
    key: string,
    patch: DesktopWindowPreferencesPatch,
    version: number,
    generation: string,
  ): Promise<DesktopWindowReceipt> {
    if (generation !== this.generation) return Promise.reject(this.failure('stale'));
    const checked = desktopWindowPreferencesPatchSchema.parse(structuredClone(patch));
    return this.admit(async () => {
      const receipt = this.store.update(key, checked, version, generation);
      await this.reconcile(checked.bounds !== undefined && checked.bounds !== null).catch(() => {
        this.application = 'failed';
      });
      return receipt;
    });
  }
  retry(generation: string): Promise<void> {
    if (generation !== this.generation) return Promise.reject(this.failure('stale'));
    return this.admit(() => this.reconcile(true));
  }
  private admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted || this.pending >= 32)
      return Promise.reject(this.failure('unavailable'));
    this.pending++;
    const task = this.queue.then(() => {
      this.lifetime.signal.throwIfAborted();
      return work();
    });
    this.queue = task.then(
      () => {},
      () => {},
    );
    void task.then(
      () => this.pending--,
      () => this.pending--,
    );
    return task;
  }
  private async reconcile(applyBounds = false): Promise<void> {
    if (!this.native) {
      this.application = 'unavailable';
      return;
    }
    this.lifetime.signal.throwIfAborted();
    this.application = 'pending';
    const record = this.store.read();
    try {
      const state = await this.native.configure(record, this.lifetime.signal, applyBounds);
      this.nativeState = state;
      this.appliedVersion = state.appliedVersion;
      this.application =
        state.appliedVersion === record.version &&
        (!record.preferences.globalHotkey || state.globalHotkeyRegistered)
          ? 'ready'
          : 'failed';
    } catch (error) {
      this.application = 'failed';
      throw error;
    }
  }
  private async poll(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      await this.delay(this.store.read().preferences.rememberWindowSize ? 250 : 1000);
      if (this.lifetime.signal.aborted) break;
      await this.admit(async () => {
        const record = this.store.read();
        if (record.version !== this.appliedVersion) await this.reconcile();
        if (!record.preferences.rememberWindowSize || !this.native) return;
        const state = await this.native.state(this.lifetime.signal);
        this.nativeState = state;
        if (!this.persistObservedBounds(state)) return;
        await this.reconcile();
      }).catch(() => {
        if (!this.lifetime.signal.aborted) this.application = 'failed';
      });
    }
  }
  private persistObservedBounds(state: NativeDesktopWindowState): boolean {
    const current = this.store.read();
    if (
      !state.bounds ||
      state.appliedVersion !== current.version ||
      !current.preferences.rememberWindowSize ||
      JSON.stringify(state.bounds) === JSON.stringify(current.preferences.bounds)
    )
      return false;
    this.store.update(randomUUID(), { bounds: state.bounds }, current.version, this.generation);
    return true;
  }
  private async flushBounds(): Promise<void> {
    if (!this.native || !this.store.read().preferences.rememberWindowSize) return;
    const final = new AbortController();
    const timer = setTimeout(() => final.abort(), 1000);
    let state: NativeDesktopWindowState;
    try {
      // Join the actual request even after cancellation; never release storage early.
      state = await this.native.state(final.signal);
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
    this.persistObservedBounds(state);
  }
  private delay(ms: number, signal: AbortSignal = this.lifetime.signal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  watch(signal: AbortSignal): AsyncIterableIterator<DesktopWindowUpdate> {
    if (this.lifetime.signal.aborted) throw this.failure('closed');
    if (this.followers.size >= 64) throw this.failure('capacity');
    signal.throwIfAborted();
    const local = new AbortController(),
      combined = AbortSignal.any([signal, local.signal, this.lifetime.signal]);
    const snapshotNow = this.snapshot.bind(this),
      delay = this.delay.bind(this),
      followers = this.followers;
    const iterator = (async function* (): AsyncGenerator<DesktopWindowUpdate> {
      let previous = '',
        initial = true;
      try {
        while (!combined.aborted) {
          const snapshot = snapshotNow(),
            encoded = JSON.stringify(snapshot);
          if (encoded !== previous) {
            previous = encoded;
            yield { ...snapshot, type: initial ? 'baseline' : 'replace' };
            initial = false;
          } else await delay(100, combined);
        }
      } finally {
        release();
      }
    })();
    function release(): void {
      followers.delete(entry);
    }
    const entry = { stop: () => local.abort(), done: () => iterator.return(undefined) };
    this.followers.add(entry);
    return {
      next: () => iterator.next(),
      return: async () => {
        local.abort();
        followers.delete(entry);
        return iterator.return(undefined);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      const followers = [...this.followers];
      for (const follower of followers) follower.stop();
      await Promise.allSettled(followers.map((follower) => follower.done()));
      this.followers.clear();
      await this.queue;
      await this.polling;
      await this.flushBounds();
    })());
  }
  private failure(reason: 'stale' | 'closed' | 'capacity' | 'unavailable') {
    return new RemoteError('desktop/failure', 'Desktop preferences are unavailable', { reason });
  }
}
