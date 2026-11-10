import {
  desktopLifecycleStateSchema,
  type DesktopLifecycleState,
  type NativeDesktopLifecycle,
} from '@axterm/infra-desktop-native';
interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}
/** The shell owns OS events; only a bounded native state crosses to its Host. */
export class ShellPowerLifecycle implements NativeDesktopLifecycle {
  private snapshot: DesktopLifecycleState = {
    revision: 0,
    state: 'active',
    lastEvent: 'started',
    changedAt: new Date().toISOString(),
  };
  private closed = false;
  private readonly suspend = () => this.record('suspend');
  private readonly resume = () => this.record('resume');
  constructor(private readonly power: PowerEvents) {
    power.on('suspend', this.suspend);
    power.on('resume', this.resume);
  }
  state(signal: AbortSignal): Promise<DesktopLifecycleState> {
    signal.throwIfAborted();
    if (this.closed) return Promise.reject(Error('POWER_LIFECYCLE_CLOSED'));
    return Promise.resolve({ ...this.snapshot });
  }
  private record(event: 'suspend' | 'resume') {
    if (this.closed || this.snapshot.revision === Number.MAX_SAFE_INTEGER) return;
    this.snapshot = desktopLifecycleStateSchema.parse({
      revision: this.snapshot.revision + 1,
      state: event === 'suspend' ? 'suspended' : 'active',
      lastEvent: event,
      changedAt: new Date().toISOString(),
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.power.removeListener('suspend', this.suspend);
    this.power.removeListener('resume', this.resume);
  }
}
