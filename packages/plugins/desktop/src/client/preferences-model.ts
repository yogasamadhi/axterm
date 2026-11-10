import type {} from '@axterm/plugin-desktop/remote';
import type { Context } from '@deepseek-ai/cordis';
import type {
  DesktopWindowBaseline,
  DesktopWindowReplacement,
  DesktopWindowPreferencesPatch,
  DesktopWindowReceipt,
  DesktopWindowUpdate,
} from '@axterm/plugin-api/desktop';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
export type DesktopPreferenceState =
  | { status: 'connecting' }
  | { status: 'error' }
  | { status: 'ready'; baseline: DesktopWindowBaseline };
/** One canonical Client model; replacements update the entire small preference fact. */
export class DesktopPreferencesModel {
  private state: DesktopPreferenceState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteSnapshotStream<DesktopWindowBaseline, DesktopWindowReplacement>;
  private retrying: Promise<void> | undefined;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
  }
  private open(): RemoteSnapshotStream<DesktopWindowBaseline, DesktopWindowReplacement> {
    const stream = new RemoteSnapshotStream<DesktopWindowBaseline, DesktopWindowReplacement>(
      this.ctx.remote.$stream<DesktopWindowUpdate>({
        name: 'desktop.preferences',
        open: (signal) => this.ctx.remote.desktop.watchWindowPreferences(signal),
        ended: () => Error('Desktop preferences ended'),
      }),
      {
        name: 'desktop.preferences',
        isSnapshot: (value): value is DesktopWindowBaseline => value.type === 'baseline',
        replace: (baseline) => this.publish({ status: 'ready', baseline }),
        update: (value) => {
          const current = this.state;
          if (
            current.status !== 'ready' ||
            current.baseline.generation !== value.generation ||
            current.baseline.cursor > value.cursor
          )
            throw Error('DESKTOP_PREFERENCE_REPLACEMENT_INVALID');
          this.publish({ status: 'ready', baseline: { ...value, type: 'baseline' } });
        },
        failed: () => this.publish({ status: 'error' }),
      },
    );
    stream.start();
    return stream;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) throw Error('DESKTOP_PREFERENCES_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    if (this.closed) throw Error('DESKTOP_PREFERENCES_CLOSED');
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.closed) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async update(
    key: string,
    patch: DesktopWindowPreferencesPatch,
    version: number,
    generation: string,
  ): Promise<DesktopWindowReceipt> {
    if (this.closed) throw Error('DESKTOP_PREFERENCES_CLOSED');
    return this.track(
      (async () => {
        const result = await this.ctx.remote.desktop.updateWindowPreferences(
          key,
          patch,
          version,
          generation,
        );
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  async retryApplication(generation: string): Promise<void> {
    if (this.closed) throw Error('DESKTOP_PREFERENCES_CLOSED');
    await this.track(
      (async () => {
        const result = await this.ctx.remote.desktop.retryWindowPreferences(generation);
        if (!result.ok) throw result.error;
      })(),
    );
  }
  private track<T>(task: Promise<T>): Promise<T> {
    if (this.closed) {
      void task.catch(() => {});
      throw Error('DESKTOP_PREFERENCES_CLOSED');
    }
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private publish(state: DesktopPreferenceState): void {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('DESKTOP_PREFERENCE_OBSERVER_FAILED');
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.stream.dispose();
    await this.retrying;
    await Promise.allSettled([...this.pending]);
    this.listeners.clear();
  }
}
