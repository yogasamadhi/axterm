import type { FileGrant } from '@axterm/plugin-api/files';
import type { FileGrantsModel } from '../index.ts';
type Facts = Pick<FileGrantsModel, 'getSnapshot' | 'subscribe'>;
/** Wait only for accepted owner facts; never synthesize, acquire or revoke Native authority. */
export class InitialDirectories {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<FileGrant>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly files: Facts) {}
  resourceCount(): number {
    return this.pending.size;
  }
  take(id: string, generation: string, signal?: AbortSignal): Promise<FileGrant> {
    if (this.closing || this.pending.size >= 4)
      return Promise.reject(Error('FILES_INITIAL_DIRECTORY_CAPACITY'));
    if (!id || id.length > 256) return Promise.reject(Error('FILES_INITIAL_DIRECTORY_INVALID'));
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = this.wait(id, generation, owned);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
    })());
  }
  private wait(id: string, generation: string, signal: AbortSignal): Promise<FileGrant> {
    if (signal.aborted) return Promise.reject(Error('FILES_INITIAL_DIRECTORY_CANCELED'));
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const timer = setTimeout(() => finish(Error('FILES_INITIAL_DIRECTORY_TIMEOUT')), 10000);
      const finish = (error?: Error, grant?: FileGrant) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(grant!);
      };
      const abort = () => finish(Error('FILES_INITIAL_DIRECTORY_CANCELED'));
      const check = () => {
        const state = this.files.getSnapshot();
        if (state.status === 'error') {
          finish(Error('FILES_INITIAL_DIRECTORY_UNAVAILABLE'));
          return;
        }
        if (state.status !== 'ready') return;
        if (state.baseline.generation !== generation) {
          finish(Error('FILES_INITIAL_DIRECTORY_RETIRED'));
          return;
        }
        const grant = state.baseline.grants.find((value) => value.grantId === id);
        if (!grant) return;
        if (
          grant.kind !== 'directory' ||
          !grant.permissions.includes('read') ||
          (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
        )
          finish(Error('FILES_INITIAL_DIRECTORY_UNAVAILABLE'));
        else finish(undefined, grant);
      };
      try {
        off = this.files.subscribe(check);
        if (done) {
          off();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      } catch {
        finish(Error('FILES_INITIAL_DIRECTORY_UNAVAILABLE'));
      }
    });
  }
}
