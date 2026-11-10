import { mkdir, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLock } from '@axterm/infra-atomic-write';
import { ApplicationError } from '../application/errors.ts';
import type { AiRunJournal } from './run-journal.ts';
const failure = () =>
  new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI owner coordination unavailable', 503);
/** Conservative process proof. Live, reused, own and foreign-user PIDs cannot be recovered. */
export function aiProcessExited(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
  }
}
/** The caller MUST retain this lease until every accepted operation and actual owner drain finishes. */
export class AiOwnerLease {
  private held = false;
  private settled = false;
  private failed = false;
  private readonly release = Promise.withResolvers<void>();
  private readonly ready = Promise.withResolvers<void>();
  private readonly task: Promise<void>;
  private readonly recoveries = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly directory: string,
    private readonly profile: string,
    signal?: AbortSignal,
  ) {
    this.task = withFileLock(
      this.path(profile),
      async () => {
        this.held = true;
        this.ready.resolve();
        await this.release.promise;
        this.held = false;
      },
      { waitMs: 0, ...(signal ? { signal } : {}) },
    );
    void this.task.then(
      () => {
        this.settled = true;
      },
      () => {
        this.failed = true;
        this.settled = true;
        this.ready.reject(failure());
      },
    );
  }
  static async open(
    directory: string,
    profile: string,
    signal?: AbortSignal,
  ): Promise<AiOwnerLease> {
    if (!isAbsolute(directory) || !profile || profile.length > 128) throw failure();
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure();
    const lease = new AiOwnerLease(await realpath(directory), profile, signal);
    try {
      await lease.ready.promise;
      signal?.throwIfAborted();
      return lease;
    } catch (error) {
      lease.release.resolve();
      await lease.task.catch(() => {});
      throw error instanceof ApplicationError ? error : failure();
    }
  }
  active(): boolean {
    return this.held || this.failed || !this.settled;
  }
  assert(): void {
    if (!this.held || this.closing || this.failed) throw failure();
  }
  recover(journal: AiRunJournal): Promise<{ interrupted: number; blockedProfiles: string[] }> {
    try {
      this.assert();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.recoveries.size)
      return Promise.reject(new ApplicationError('CONFLICT', 'AI recovery already active'));
    const task = Promise.resolve().then(() => this.recoverOwned(journal));
    this.recoveries.add(task);
    void task.then(
      () => this.recoveries.delete(task),
      () => this.recoveries.delete(task),
    );
    return task;
  }
  private async recoverOwned(
    journal: AiRunJournal,
  ): Promise<{ interrupted: number; blockedProfiles: string[] }> {
    this.assert();
    let interrupted = 0;
    const blockedProfiles: string[] = [];
    const owners = journal.activeOwners();
    if (owners.length > 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'AI recovery capacity reached');
    for (const owner of owners) {
      this.assert();
      if (!aiProcessExited(owner.pid)) continue;
      if (owner.profile === this.profile) {
        interrupted += journal.interruptStoppedOwner(owner, aiProcessExited);
        continue;
      }
      let entered = false;
      let callbackError: unknown;
      try {
        await withFileLock(
          this.path(owner.profile),
          async () => {
            entered = true;
            try {
              this.assert();
              interrupted += journal.interruptStoppedOwner(owner, aiProcessExited);
            } catch (error) {
              callbackError = error;
              throw error;
            }
          },
          { waitMs: 0 },
        );
      } catch (error) {
        if (entered && error !== callbackError) this.failed = true;
        if (
          !entered &&
          error instanceof Error &&
          error.message.startsWith('atomic-write: timed out waiting for the writer lock')
        )
          blockedProfiles.push(owner.profile);
        else throw error instanceof ApplicationError ? error : failure();
      }
    }
    return { interrupted, blockedProfiles: [...new Set(blockedProfiles)] };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.recoveries]);
      if (this.failed) throw failure();
      this.release.resolve();
      try {
        await this.task;
      } catch {
        this.failed = true;
        throw failure();
      }
    })());
  }
  private path(profile: string): string {
    return join(this.directory, 'owner-' + createHash('sha256').update(profile).digest('hex'));
  }
}
