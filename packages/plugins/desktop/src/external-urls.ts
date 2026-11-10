import { RemoteError } from '@axterm/plugin-api';
import { externalHttpUrlSchema } from '@axterm/plugin-api/desktop';
import type { NativeExternalUrls } from '@axterm/plugin-api/host';
import { z } from 'zod';
const failure = (reason: 'invalid-input' | 'unavailable' | 'closed' | 'capacity' | 'uncertain') =>
  new RemoteError('desktop/failure', 'External navigation failed', { reason });
/** Host operations retain shell ownership across cancellation and stop before the native channel closes. */
export class DesktopExternalUrls {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private undrained = false;
  constructor(private readonly native: () => NativeExternalUrls | undefined) {}
  open(key: string, url: string, signal: AbortSignal): Promise<void> {
    if (this.closing) return Promise.reject(failure('closed'));
    if (this.pending.size >= 16) return Promise.reject(failure('capacity'));
    const target = externalHttpUrlSchema.safeParse(url);
    if (!target.success || !z.uuid().safeParse(key).success)
      return Promise.reject(failure('invalid-input'));
    const native = this.native();
    if (!native) return Promise.reject(failure('unavailable'));
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    if (owned.aborted) return Promise.reject(failure('closed'));
    const task = Promise.resolve().then(async () => {
      try {
        await native.open(key, target.data, owned);
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (['INVALID', 'FORBIDDEN', 'CONFLICT'].includes(code)) throw failure('invalid-input');
        if (code === 'UNAVAILABLE') throw failure('unavailable');
        if (code === 'LIMIT') throw failure('capacity');
        try {
          await native.drain(key);
        } catch {
          this.undrained = true;
        }
        throw failure('uncertain');
      }
    });
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
