import { mkdir, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '@axterm/infra-atomic-write';
import { SyncWorkflowError } from '../application/sync-errors.ts';
export interface SyncResourceLease {
  readonly resourceId: string;
  readonly signal: AbortSignal;
  assert(): void;
}
/** Holds only temporary IO coordination. All business facts/outcomes remain in ctx.storage. */
export class SyncResourceCoordinator {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failed = new Set<string>();
  private readonly ready: Promise<string>;
  private closing: Promise<void> | undefined;
  constructor(
    directory: string,
    private readonly lock: typeof withFileLock = withFileLock,
  ) {
    this.ready = (async () => {
      if (!isAbsolute(directory)) throw new SyncWorkflowError('invalid-input');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const value = await lstat(directory);
      if (!value.isDirectory() || value.isSymbolicLink())
        throw new SyncWorkflowError('unavailable');
      return realpath(directory);
    })();
    void this.ready.catch(() => {});
  }
  async init(): Promise<void> {
    await this.ready;
    if (this.lifetime.signal.aborted) throw new SyncWorkflowError('closed');
  }
  resourceCount(): number {
    return this.pending.size + this.failed.size;
  }
  active(): boolean {
    return this.pending.size > 0 || this.failed.size > 0;
  }
  withResource<T>(
    resourceId: string,
    operation: (lease: SyncResourceLease) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new SyncWorkflowError('closed'));
    if (!z.uuid().safeParse(resourceId).success)
      return Promise.reject(new SyncWorkflowError('invalid-input'));
    if (this.failed.has(resourceId)) return Promise.reject(new SyncWorkflowError('unavailable'));
    if (this.pending.size >= 4) return Promise.reject(new SyncWorkflowError('capacity'));
    const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = (async () => {
      const directory = await this.ready;
      lifetime.throwIfAborted();
      let entered = false;
      let callbackError: unknown;
      try {
        return await this.lock(
          join(directory, resourceId),
          async () => {
            entered = true;
            let live = true;
            const lease: SyncResourceLease = Object.freeze({
              resourceId,
              signal: lifetime,
              assert() {
                if (!live || lifetime.aborted) throw new SyncWorkflowError('cancelled');
              },
            });
            try {
              lease.assert();
              return await operation(lease);
            } catch (error) {
              callbackError = error;
              throw error;
            } finally {
              live = false;
            }
          },
          { waitMs: 0, signal: lifetime },
        );
      } catch (error) {
        if (entered && error !== callbackError) {
          this.failed.add(resourceId);
          throw new SyncWorkflowError('unavailable');
        }
        if (entered) throw error;
        if (lifetime.aborted) throw new SyncWorkflowError('cancelled');
        if (
          error instanceof Error &&
          error.message.startsWith('atomic-write: timed out waiting for the writer lock')
        )
          throw new SyncWorkflowError('conflict');
        throw new SyncWorkflowError('unavailable');
      }
    })();
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await this.ready.catch(() => {});
      if (this.failed.size) throw new SyncWorkflowError('unavailable');
    })());
  }
}

/** Conservative local liveness proof; reused/live/foreign-user PIDs are never treated as exited. */
export function syncProcessExited(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
  }
}
