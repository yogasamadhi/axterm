import type { Context } from '@deepseek-ai/cordis';
import type {
  DesktopDiagnosticsBaseline,
  DesktopDiagnosticsReplacement,
  DesktopDiagnosticsUpdate,
} from '@axterm/plugin-api/desktop';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
export type DiagnosticsState =
  { status: 'connecting' | 'error' } | { status: 'ready'; baseline: DesktopDiagnosticsBaseline };
/** One model per Client, observed only while the retained diagnostics details is expanded. */
export class DesktopDiagnosticsModel {
  private state: DiagnosticsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private stream:
    RemoteSnapshotStream<DesktopDiagnosticsBaseline, DesktopDiagnosticsReplacement> | undefined;
  private views = 0;
  private dirty = false;
  private restart = false;
  private changing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  getSnapshot = () => this.state;
  constructor(private readonly ctx: Context) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  acquire(): () => void {
    if (this.closing || this.views >= 8) throw Error('DIAGNOSTICS_VIEW_UNAVAILABLE');
    this.views++;
    this.reconcile();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.closing) {
        this.views--;
        this.reconcile();
      }
    };
  }
  retry(): void {
    if (this.closing) throw Error('DIAGNOSTICS_CLOSED');
    this.restart = true;
    this.reconcile();
  }
  private reconcile(): void {
    this.dirty = true;
    if (this.changing) return;
    const task = Promise.resolve()
      .then(async () => {
        do {
          this.dirty = false;
          if ((!this.views || this.closing || this.restart) && this.stream) {
            const stream = this.stream;
            this.stream = undefined;
            await stream.dispose();
          }
          this.restart = false;
          if (this.views && !this.closing && !this.stream) {
            this.publish({ status: 'connecting' });
            this.stream = new RemoteSnapshotStream<
              DesktopDiagnosticsBaseline,
              DesktopDiagnosticsReplacement
            >(
              this.ctx.remote.$stream<DesktopDiagnosticsUpdate>({
                name: 'desktop.diagnostics',
                open: (signal) => this.ctx.remote.desktop.watchDiagnostics(signal),
                ended: () => Error('Diagnostics observation ended'),
              }),
              {
                name: 'desktop.diagnostics',
                isSnapshot: (value): value is DesktopDiagnosticsBaseline =>
                  value.type === 'baseline',
                replace: (baseline) => this.publish({ status: 'ready', baseline }),
                update: (value) => {
                  if (
                    this.state.status !== 'ready' ||
                    this.state.baseline.diagnostics.generation !== value.diagnostics.generation
                  )
                    throw Error('DIAGNOSTICS_REPLACEMENT_INVALID');
                  this.publish({ status: 'ready', baseline: { ...value, type: 'baseline' } });
                },
                failed: () => this.publish({ status: 'error' }),
              },
            );
            this.stream.start();
          }
        } while (this.dirty);
      })
      .catch(() => this.publish({ status: 'error' }))
      .finally(() => {
        if (this.changing === task) this.changing = undefined;
        if (this.dirty) this.reconcile();
      });
    this.changing = task;
  }
  private publish(state: DiagnosticsState): void {
    if (this.closing) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('DIAGNOSTICS_OBSERVER_FAILED');
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      this.reconcile();
      while (this.changing) await this.changing;
      this.listeners.clear();
    }));
  }
}
