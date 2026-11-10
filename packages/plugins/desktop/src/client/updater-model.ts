import type { Context } from '@deepseek-ai/cordis';
import type {
  DesktopUpdaterBaseline,
  DesktopUpdaterReplacement,
  DesktopUpdaterUpdate,
} from '@axterm/plugin-api/desktop';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
export type DesktopUpdaterState =
  { status: 'connecting' | 'error' } | { status: 'ready'; baseline: DesktopUpdaterBaseline };
/** A full baseline replaces each observation, including reconnects; no Query business cache. */
export class DesktopUpdaterModel {
  private state: DesktopUpdaterState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream: RemoteSnapshotStream<DesktopUpdaterBaseline, DesktopUpdaterReplacement>;
  private retrying: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
  }
  private open(): RemoteSnapshotStream<DesktopUpdaterBaseline, DesktopUpdaterReplacement> {
    const stream = new RemoteSnapshotStream<DesktopUpdaterBaseline, DesktopUpdaterReplacement>(
      this.ctx.remote.$stream<DesktopUpdaterUpdate>({
        name: 'desktop.updater',
        open: (signal) => this.ctx.remote.desktop.watchUpdater(signal),
        ended: () => Error('Desktop updater observation ended'),
      }),
      {
        name: 'desktop.updater',
        isSnapshot: (value): value is DesktopUpdaterBaseline => value.type === 'baseline',
        replace: (baseline) => this.publish({ status: 'ready', baseline }),
        update: (value) => {
          if (this.state.status !== 'ready' || this.state.baseline.generation !== value.generation)
            throw Error('DESKTOP_UPDATER_REPLACEMENT_INVALID');
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
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    if (this.closing) throw Error('DESKTOP_UPDATER_CLOSED');
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.closing) {
        this.publish({ status: 'connecting' });
        this.stream = this.open();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  private publish(state: DesktopUpdaterState): void {
    if (this.closing) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('DESKTOP_UPDATER_OBSERVER_FAILED');
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.stream.dispose();
      await this.retrying;
      this.listeners.clear();
    })());
  }
}
