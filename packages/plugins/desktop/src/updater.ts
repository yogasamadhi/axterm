import type { NativeDesktopUpdater } from '@axterm/plugin-api/host';
import { RemoteError } from '@axterm/plugin-api';
import type { UpdaterAction, UpdaterStatus } from '@axterm/plugin-api/desktop';
import { updaterActionSchema } from '@axterm/plugin-api/desktop';
import { z } from 'zod';
const failure = (reason: 'invalid-input' | 'unavailable' | 'closed' | 'capacity' | 'uncertain') =>
  new RemoteError('desktop/failure', 'Desktop update failed', { reason });
/** Host retains cancellation/drain ownership until the Shell's real work has completed. */
export class DesktopUpdates {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<UpdaterStatus>>();
  private closing: Promise<void> | undefined;
  private undrained = false;
  constructor(private readonly native: () => NativeDesktopUpdater | undefined) {}
  active(): boolean {
    return this.pending.size > 0 || this.undrained;
  }
  status(signal: AbortSignal): Promise<UpdaterStatus> {
    if (this.closing) return Promise.reject(failure('closed'));
    if (this.pending.size >= 32) return Promise.reject(failure('capacity'));
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    if (owned.aborted) return Promise.reject(failure('closed'));
    return this.track(this.native()?.status(owned) ?? Promise.resolve({ state: 'disabled' }));
  }
  perform(key: string, action: UpdaterAction, signal: AbortSignal): Promise<UpdaterStatus> {
    if (this.closing) return Promise.reject(failure('closed'));
    if (this.pending.size >= 32) return Promise.reject(failure('capacity'));
    if (!z.uuid().safeParse(key).success || !updaterActionSchema.safeParse({ action }).success)
      return Promise.reject(failure('invalid-input'));
    const native = this.native();
    if (!native) return Promise.reject(failure('unavailable'));
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    if (owned.aborted) return Promise.reject(failure('closed'));
    return this.track(
      Promise.resolve().then(async () => {
        try {
          return await native.perform(key, action, owned);
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
          if (['INVALID', 'FORBIDDEN', 'CONFLICT'].includes(String(code)))
            throw failure('invalid-input');
          if (code === 'UNAVAILABLE') throw failure('unavailable');
          if (code === 'LIMIT') throw failure('capacity');
          try {
            await native.drain(key);
          } catch {
            this.undrained = true;
          }
          throw failure('uncertain');
        }
      }),
    );
  }
  private track(task: Promise<UpdaterStatus>): Promise<UpdaterStatus> {
    this.pending.add(task);
    const release = () => this.pending.delete(task);
    void task.then(release, release);
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      if (this.undrained) throw failure('uncertain');
    })());
  }
}
