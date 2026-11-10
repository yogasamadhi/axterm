import {
  desktopLifecycleStateSchema,
  type DesktopLifecycleState,
  type NativeDesktopLifecycle,
} from '@axterm/plugin-api/desktop';
/** One native request/timer and one latest state, independent of the number of Remote observers. */
export class DesktopLifecycle {
  private readonly lifetime = new AbortController();
  private current: DesktopLifecycleState | undefined;
  private readonly waiters = new Set<() => void>();
  private readonly polling: Promise<void>;
  constructor(private readonly native: NativeDesktopLifecycle | undefined) {
    this.polling = native ? this.poll() : Promise.resolve();
  }
  async *watch(signal: AbortSignal): AsyncGenerator<DesktopLifecycleState | undefined> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    let previous: DesktopLifecycleState | undefined;
    let first = true;
    while (!lifetime.aborted) {
      const snapshot = this.current;
      if (first || snapshot !== previous) {
        first = false;
        previous = snapshot;
        yield snapshot ? { ...snapshot } : undefined;
        continue;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          this.waiters.delete(done);
          lifetime.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.add(done);
        lifetime.addEventListener('abort', done, { once: true });
        if (lifetime.aborted || this.current !== previous) done();
      });
    }
  }
  private async poll() {
    while (!this.lifetime.signal.aborted) {
      try {
        const state = desktopLifecycleStateSchema.parse(
          await this.native!.state(this.lifetime.signal),
        );
        if (
          !this.lifetime.signal.aborted &&
          (!this.current || state.revision > this.current.revision)
        ) {
          this.current = state;
          for (const wake of [...this.waiters]) wake();
        }
      } catch {
        /* Native failures cannot fabricate an OS event or force business retries. */
      }
      if (this.lifetime.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.lifetime.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        timer.unref?.();
        this.lifetime.signal.addEventListener('abort', done, { once: true });
        if (this.lifetime.signal.aborted) done();
      });
    }
  }
  resourceCount(): number {
    return this.native && !this.lifetime.signal.aborted ? 1 : 0;
  }
  async close() {
    this.lifetime.abort();
    await this.polling;
  }
}
