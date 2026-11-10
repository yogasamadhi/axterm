import type { DesktopWindowUi } from '@axterm/ui/workspace';
import type { DesktopWindowPresentationState } from '@axterm/plugin-api/shortcuts';
interface Presentation {
  readonly value: DesktopWindowPresentationState | undefined;
  readonly busy: boolean;
  readonly error: boolean;
}
/** Transient native presentation only. At most one actual read and one action; no input replay. */
export class WindowControlsOwner {
  private state: Presentation = { value: undefined, busy: false, error: false };
  private readonly listeners = new Set<() => void>();
  private read: Promise<void> | undefined;
  private action: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private revision = 0;
  constructor(private readonly port: DesktopWindowUi) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) throw Error('WINDOW_CONTROLS_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(Error('WINDOW_CONTROLS_CLOSED'));
    return this.action ?? this.readFresh();
  }
  schedule = (): void => {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => {});
    }, 100);
  };
  perform(action: Parameters<DesktopWindowUi['act']>[0]): Promise<void> {
    if (this.closed || this.action) return Promise.reject(Error('WINDOW_CONTROLS_UNAVAILABLE'));
    this.revision++;
    this.publish({ ...this.state, busy: true, error: false });
    const task = Promise.resolve()
      .then(() => {
        if (this.closed) throw Error('WINDOW_CONTROLS_CLOSED');
        return this.port.act(action);
      })
      .then(async () => {
        await this.read?.catch(() => {});
        if (!this.closed) await this.readFresh();
      })
      .catch((error) => {
        this.publish({ ...this.state, error: true });
        throw error;
      })
      .finally(() => {
        this.action = undefined;
        this.publish({ ...this.state, busy: false });
      });
    this.action = task;
    return task;
  }
  private readFresh(): Promise<void> {
    if (this.closed) return Promise.reject(Error('WINDOW_CONTROLS_CLOSED'));
    if (this.read) return this.read;
    const revision = this.revision;
    const task = Promise.resolve()
      .then(() => {
        if (this.closed) throw Error('WINDOW_CONTROLS_CLOSED');
        return this.port.getState();
      })
      .then((value) => {
        if (revision === this.revision) this.publish({ ...this.state, value, error: false });
      })
      .catch((error) => {
        if (revision === this.revision) this.publish({ ...this.state, error: true });
        throw error;
      })
      .finally(() => {
        if (this.read === task) this.read = undefined;
      });
    this.read = task;
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.read, this.action]);
    this.listeners.clear();
  }
  private publish(state: Presentation): void {
    if (this.closed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('WINDOW_CONTROLS_OBSERVER_FAILED');
      }
    }
  }
}
