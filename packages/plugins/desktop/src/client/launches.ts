import type { Context } from '@deepseek-ai/cordis';
import { desktopLaunchSchema, type DesktopLaunch } from '@axterm/plugin-api/session-intents';
import type { RemoteStream } from '@axterm/infra-gateway/client';
interface State {
  readonly status: 'listening' | 'error';
  readonly failed: boolean;
}
/** Realtime native delivery only. Source secrets remain inside the current invocation closure. */
export class DesktopLaunchModel {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private state: State = { status: 'listening', failed: false };
  private stream: RemoteStream<DesktopLaunch>;
  private done: Promise<void>;
  private closing: Promise<void> | undefined;
  private retrying: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly windowId: string,
    private readonly launch: (source: string, signal: AbortSignal) => Promise<boolean>,
  ) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closing) throw Error('DESKTOP_LAUNCH_MODEL_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retry(): Promise<void> {
    if (this.closing) return Promise.reject(Error('DESKTOP_LAUNCH_MODEL_CLOSED'));
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (this.lifetime.signal.aborted) return;
      this.publish({ status: 'listening', failed: false });
      this.stream = this.open();
      this.done = this.consume(this.stream);
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  dismiss(): void {
    this.publish({ ...this.state, failed: false });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.stream.dispose();
      await this.done;
      await this.retrying;
      this.listeners.clear();
    })());
  }
  private open(): RemoteStream<DesktopLaunch> {
    return this.ctx.remote.$stream<DesktopLaunch>({
      name: 'desktop.launches',
      open: (signal) => this.ctx.remote.desktop.watchDesktopLaunches(this.windowId, signal),
      ended: () => Error('DESKTOP_LAUNCH_STREAM_ENDED'),
    });
  }
  private async consume(stream: RemoteStream<DesktopLaunch>): Promise<void> {
    try {
      for await (const frame of stream) {
        if (this.lifetime.signal.aborted) return;
        const event = desktopLaunchSchema.parse(frame.value);
        frame.accept();
        const signal = AbortSignal.any([this.lifetime.signal, frame.signal]);
        let accepted = false;
        try {
          accepted = await this.launch(event.source, signal);
        } catch {
          /* Sanitized UI feedback only. No automatic command replay. */
        }
        if (!this.lifetime.signal.aborted) this.publish({ status: 'listening', failed: !accepted });
      }
    } catch {
      if (!this.lifetime.signal.aborted) this.publish({ status: 'error', failed: true });
    }
  }
  private publish(state: State): void {
    this.state = Object.freeze(state);
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('DESKTOP_LAUNCH_OBSERVER_FAILED');
        }
      }
  }
}
