import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createTransferSchema,
  type Transfer,
  type TransferRequest,
  type CreateTransferInput,
  type TransferConflictDecision,
} from '@axterm/plugin-api/transfers';
import type { RemoteFileTarget } from '@axterm/plugin-api/files';
import {
  RemoteFileCapabilityUnavailableError,
  type ConnectionsApplication,
  type HostFiles,
  type LocalFileLease,
  type RemoteFilesystem,
  type RemoteFileAttributes,
} from '@axterm/plugin-api/host';
import type { TransferRepository } from '../ports/repository.ts';
import type { ArchiveTransfers } from '../ports/archive.ts';
import { ApplicationError } from './errors.ts';
import { transferOperationScope } from './operation-scope.ts';
import { TransferIOQueue, transferPool } from './io-queue.ts';
export const MAX_ACTIVE_TRANSFERS = 32;
export const MAX_RETRY_TRANSFERS = 200;
const MAX_ENTRIES = 20_000,
  MAX_BYTES = 16 * 1024 ** 4,
  MAX_DEPTH = 64;
type Strategy = TransferConflictDecision['strategy'];
interface Replacement {
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}
interface Managed {
  replacements: Replacement[];
  metadata: Transfer;
  request: TransferRequest;
  abort: AbortController;
  started: number;
  paused: boolean;
  resume?: () => void;
  waiting?: Promise<void>;
  conflict?: { resolve(strategy: Strategy): void; reject(error: Error): void };
  strategy?: Strategy;
  local?: LocalFileLease;
  connectionLost: boolean;
  entries: number;
  plannedBytes: number;
}
export interface TransferEvents {
  publish(type: 'transfer.progress', transfer: Transfer): void;
}
/** Transfer intent owns reservations, cancellation and every source/destination lease. */
export class TransferService {
  private readonly active = new Map<string, Managed>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, TransferRequest>();
  private accepting = true;
  private closing: Promise<void> | undefined;
  private failed = false;
  private readonly io = new TransferIOQueue();
  constructor(
    private readonly connections: ConnectionsApplication,
    private readonly files: HostFiles,
    private readonly repository: TransferRepository,
    private readonly events: TransferEvents,
    private readonly archives: ArchiveTransfers,
  ) {}
  commandOutcome(key: string) {
    const result = this.repository.commandOutcome(key);
    return result.status === 'accepted'
      ? { status: 'accepted' as const, transfer: this.get(result.transfer.id) }
      : result;
  }
  create(input: CreateTransferInput, key: string): Transfer {
    if (!this.accepting) throw new ApplicationError('INVALID_STATE', 'Transfers are closing');
    const request = createTransferSchema.parse(input);
    let managed: Managed | undefined;
    const reservation = this.repository.reserve(key, request, () => {
      if (this.active.size >= MAX_ACTIVE_TRANSFERS)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Transfer task capacity exceeded', 503);
      const now = new Date().toISOString();
      const metadata: Transfer = {
        id: randomUUID(),
        connectionId: request.target.connectionId,
        direction: request.direction,
        state: 'queued',
        bytesTransferred: 0,
        source:
          request.direction === 'remote-copy'
            ? `${request.source.connectionId}:${request.sourcePath}`
            : request.direction === 'upload'
              ? (request.localPath ?? '')
              : request.remotePath,
        destination:
          request.direction === 'remote-copy'
            ? `${request.target.connectionId}:${request.targetPath}`
            : request.direction === 'upload'
              ? request.remotePath
              : (request.localPath ?? ''),
        createdAt: now,
        updatedAt: now,
      };
      managed = {
        metadata,
        request,
        abort: new AbortController(),
        started: Date.now(),
        paused: false,
        connectionLost: false,
        entries: 0,
        plannedBytes: 0,
        replacements: [],
      };
      return metadata;
    });
    if (!reservation.created) return this.withRetry(reservation.transfer);
    if (!managed) throw new Error('TRANSFER_RESERVATION_INVARIANT');
    const owned = managed;
    this.active.set(owned.metadata.id, owned);
    this.requests.set(owned.metadata.id, request);
    const done = Promise.resolve().then(() => this.run(owned));
    this.running.set(owned.metadata.id, done);
    void done.then(
      () => this.running.delete(owned.metadata.id),
      () => {
        this.failed = true;
        this.running.delete(owned.metadata.id);
      },
    );
    return this.withRetry(owned.metadata);
  }
  list(): Transfer[] {
    return this.repository
      .listTransfers()
      .map((item) => this.withRetry({ ...item, ...this.active.get(item.id)?.metadata }));
  }
  facts(): Transfer[] {
    const items = this.repository.listTransfers();
    const ids = new Set(items.map((item) => item.id));
    for (const id of this.active.keys())
      if (!ids.has(id)) items.unshift(this.repository.getTransfer(id));
    return items.slice(0, 500).map((item) => this.withRetry(item));
  }
  progressSnapshot(): Transfer[] {
    return [...this.active.values()].map((item) => this.withRetry(item.metadata));
  }
  get(id: string): Transfer {
    return this.withRetry({ ...this.repository.getTransfer(id), ...this.active.get(id)?.metadata });
  }
  cancel(id: string): void {
    const task = this.active.get(id);
    if (!task) throw new ApplicationError('NOT_FOUND', 'Active transfer not found', 404);
    task.paused = false;
    task.resume?.();
    delete task.resume;
    delete task.waiting;
    task.abort.abort();
  }
  pause(id: string): void {
    const task = this.active.get(id);
    if (!task || task.metadata.state !== 'running')
      throw new ApplicationError('INVALID_STATE', 'Only a running transfer can pause');
    task.paused = true;
    task.waiting = new Promise((resolve) => {
      task.resume = resolve;
    });
    this.transition(task, 'paused');
  }
  resume(id: string): void {
    const task = this.active.get(id);
    if (!task || task.metadata.state !== 'paused')
      throw new ApplicationError('INVALID_STATE', 'Transfer is not paused');
    task.paused = false;
    task.resume?.();
    delete task.resume;
    delete task.waiting;
    this.transition(task, 'running');
  }
  decideConflict(id: string, decision: TransferConflictDecision): void {
    const task = this.active.get(id);
    if (!task?.conflict || task.metadata.state !== 'awaiting-decision')
      throw new ApplicationError('INVALID_STATE', 'Transfer is not awaiting a decision');
    if (decision.applyToAll) task.strategy = decision.strategy;
    task.conflict.resolve(decision.strategy);
  }
  retry(id: string): Transfer {
    if (this.get(id).retryAvailability !== 'available')
      throw new ApplicationError('INVALID_STATE', 'Transfer cannot be retried');
    const request = this.requests.get(id)!;
    const result = this.create(request, randomUUID());
    this.requests.delete(id);
    return result;
  }
  clearCompleted(): number {
    const count = this.repository.clearCompletedTransfers();
    for (const id of this.requests.keys()) if (!this.active.has(id)) this.requests.delete(id);
    return count;
  }
  resourceCount(): number {
    return (
      this.active.size +
      this.running.size +
      (this.failed ? 1 : 0) +
      (this.archives.resourceCount?.() ?? 0)
    );
  }
  closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    for (const id of this.active.keys()) this.cancel(id);
    return (this.closing = (async () => {
      await Promise.allSettled([...this.running.values()]);
      this.requests.clear();
      await this.archives.close?.();
      if (this.failed || this.active.size)
        throw new ApplicationError('TRANSFER_FAILED', 'Transfers did not drain');
    })());
  }
  private async run(task: Managed): Promise<void> {
    let terminal = false;
    try {
      this.transition(task, 'preparing');
      if (task.request.direction === 'remote-copy') await this.remoteCopy(task, task.request);
      else await this.localTransfer(task, task.request);
      task.abort.signal.throwIfAborted();
      this.transition(task, 'succeeded');
      terminal = true;
    } catch (error) {
      this.transition(
        task,
        task.abort.signal.aborted && !task.connectionLost ? 'canceled' : 'failed',
        task.connectionLost
          ? 'TRANSFER_FAILED'
          : task.abort.signal.aborted
            ? undefined
            : error instanceof ApplicationError
              ? error.code
              : 'TRANSFER_FAILED',
      );
      terminal = true;
    } finally {
      if (terminal) {
        this.active.delete(task.metadata.id);
        if (task.metadata.state === 'succeeded') this.requests.delete(task.metadata.id);
      }
      let completed = this.requests.size - this.active.size;
      for (const id of this.requests.keys()) {
        if (completed <= MAX_RETRY_TRANSFERS) break;
        if (!this.active.has(id)) {
          this.requests.delete(id);
          completed--;
        }
      }
    }
  }
  private async localTransfer(
    task: Managed,
    request: Exclude<TransferRequest, { direction: 'remote-copy' }>,
  ): Promise<void> {
    const operation = transferOperationScope(task.abort.signal);
    let local: LocalFileLease;
    try {
      local = await this.files.open(
        request.grantId,
        request.direction === 'upload' ? 'read' : 'write',
        operation.signal,
      );
      operation.opened();
    } catch (error) {
      operation.release();
      throw error;
    }
    task.local = local;
    const stopped = () => {
      if (this.active.has(task.metadata.id) && !task.abort.signal.aborted)
        this.cancel(task.metadata.id);
    };
    local.signal.addEventListener('abort', stopped, { once: true });
    try {
      const localPath = request.localPath ?? local.path;
      if (request.direction === 'upload') task.metadata = { ...task.metadata, source: localPath };
      else task.metadata = { ...task.metadata, destination: localPath };
      await this.withRemote(task, request.target, (remote) =>
        this.replacing(task, async () => {
          if (request.archive) {
            if (request.target.protocol === 'ftp')
              throw new ApplicationError(
                'CAPABILITY_UNAVAILABLE',
                'Compressed FTP transfer is unavailable',
                503,
              );
            await this.archives.transfer({
              direction: request.direction,
              local,
              localPath,
              remote,
              remotePath: request.remotePath,
              signal: task.abort.signal,
              progress: () => this.progress(task),
              setTotal: (bytes) => {
                task.metadata = { ...task.metadata, totalBytes: bytes };
                this.transition(task, 'running');
              },
              conflict: (path, type) => this.conflict(task, path, type),
              exec: (command) =>
                this.connections.exec(request.target.connectionId, {
                  command,
                  maxBytes: 8192,
                  signal: task.abort.signal,
                }),
            });
            return;
          }
          const jobs =
            request.direction === 'upload'
              ? await this.prepareUpload(
                  task,
                  local,
                  remote,
                  localPath,
                  request.remotePath,
                  request.recursive,
                )
              : await this.prepareDownload(
                  task,
                  local,
                  remote,
                  request.remotePath,
                  localPath,
                  request.recursive,
                );
          task.metadata = {
            ...task.metadata,
            totalBytes: jobs.reduce((sum, job) => sum + job.size, 0),
          };
          this.transition(task, 'running');
          // A file owns its channel; FTP control commands cannot serialize a
          // simultaneous upload/download on a shared transfer connection.
          await transferPool(jobs, task.abort.signal, (job) =>
            this.io.run(task.abort.signal, () =>
              this.withRemote(task, request.target, (channel) =>
                request.direction === 'upload'
                  ? this.uploadFile(task, local, channel, job)
                  : this.downloadFile(task, local, channel, job),
              ),
            ),
          );
        }),
      );
    } finally {
      local.signal.removeEventListener('abort', stopped);
      operation.release();
      await local.close();
      delete task.local;
    }
  }
  private async withRemote<T>(
    task: Managed,
    target: RemoteFileTarget,
    perform: (files: RemoteFilesystem) => Promise<T>,
  ): Promise<T> {
    const operation = transferOperationScope(task.abort.signal);
    let lease: Awaited<ReturnType<ConnectionsApplication['openFiles']>>;
    try {
      lease = await this.connections.openFiles(target, operation.signal);
      operation.opened();
    } catch (error) {
      operation.release();
      throw error;
    }
    const lost = () => {
      if (!task.abort.signal.aborted && this.active.has(task.metadata.id)) {
        task.connectionLost = true;
        this.cancel(task.metadata.id);
      }
    };
    lease.signal.addEventListener('abort', lost, { once: true });
    try {
      task.abort.signal.throwIfAborted();
      if (lease.signal.aborted) {
        lost();
        task.abort.signal.throwIfAborted();
      }
      return await perform(lease.filesystem);
    } finally {
      lease.signal.removeEventListener('abort', lost);
      operation.release();
      await lease.close();
    }
  }
  private take(task: Managed, size = 0): void {
    if (
      ++task.entries > MAX_ENTRIES ||
      size < 0 ||
      !Number.isSafeInteger(size) ||
      (task.plannedBytes += size) > MAX_BYTES
    )
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Transfer tree or byte capacity exceeded',
        503,
      );
    task.abort.signal.throwIfAborted();
  }
  private async prepareUpload(
    task: Managed,
    local: LocalFileLease,
    remote: RemoteFilesystem,
    source: string,
    destination: string,
    recursive: boolean,
  ): Promise<Job[]> {
    const metadata = await local.stat(source);
    if (metadata.type === 'symlink') return [];
    if (metadata.type === 'file') {
      this.take(task, metadata.size);
      return [{ localPath: source, remotePath: destination, size: metadata.size }];
    }
    if (metadata.type !== 'directory' || !recursive)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Directory transfer requires recursive mode',
        400,
      );
    const root = await this.remoteDirectory(task, remote, destination, true);
    if (!root) return [];
    const jobs: Job[] = [];
    const walk = async (from: string, to: string, depth: number) => {
      if (depth > MAX_DEPTH)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Transfer depth exceeded', 503);
      for (const entry of await local.list(from)) {
        this.take(task, entry.type === 'file' ? entry.size : 0);
        if (entry.type === 'symlink') continue;
        const next = posix.join(to, entry.name);
        if (entry.type === 'directory') {
          const resolved = await this.remoteDirectory(task, remote, next, false);
          if (resolved) await walk(entry.path, resolved, depth + 1);
        } else if (entry.type === 'file')
          jobs.push({ localPath: entry.path, remotePath: next, size: entry.size });
        else
          throw new ApplicationError(
            'CAPABILITY_UNAVAILABLE',
            'Special files cannot be transferred',
            503,
          );
      }
    };
    await walk(source, root, 0);
    return jobs;
  }
  private async prepareDownload(
    task: Managed,
    local: LocalFileLease,
    remote: RemoteFilesystem,
    source: string,
    destination: string,
    recursive: boolean,
  ): Promise<Job[]> {
    const metadata = await remote.lstat(source);
    if (metadata.isSymbolicLink) return [];
    if (metadata.isFile) {
      this.take(task, metadata.size);
      return [{ localPath: destination, remotePath: source, size: metadata.size }];
    }
    if (!metadata.isDirectory || !recursive)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Directory transfer requires recursive mode',
        400,
      );
    const root = await this.localDirectory(task, local, destination, true);
    if (root === undefined) return [];
    const jobs: Job[] = [];
    const walk = async (from: string, to: string, depth: number) => {
      if (depth > MAX_DEPTH)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'Transfer depth exceeded', 503);
      for (const entry of await remote.list(from)) {
        name(entry.filename);
        if (entry.filename === '.' || entry.filename === '..') continue;
        this.take(task, entry.attrs.isFile ? entry.attrs.size : 0);
        if (entry.attrs.isSymbolicLink) continue;
        const next = posix.join(to, entry.filename);
        if (entry.attrs.isDirectory) {
          const resolved = await this.localDirectory(task, local, next, false);
          if (resolved !== undefined)
            await walk(posix.join(from, entry.filename), resolved, depth + 1);
        } else if (entry.attrs.isFile)
          jobs.push({
            localPath: next,
            remotePath: posix.join(from, entry.filename),
            size: entry.attrs.size,
          });
        else
          throw new ApplicationError(
            'CAPABILITY_UNAVAILABLE',
            'Special files cannot be transferred',
            503,
          );
      }
    };
    await walk(source, root, 0);
    return jobs;
  }
  private async uploadFile(
    task: Managed,
    local: LocalFileLease,
    remote: RemoteFilesystem,
    job: Job,
  ): Promise<void> {
    const target = await this.remoteFile(task, remote, job.remotePath);
    if (!target) return;
    const stage = posix.join(posix.dirname(target.path), `.axterm-${randomUUID()}.part`);
    try {
      await pipeline(
        await local.read(job.localPath),
        this.progress(task),
        remote.writeStream(stage, { flags: 'wx', mode: 0o600 }),
        { signal: task.abort.signal },
      );
      await this.publishRemoteFile(remote, stage, target);
    } catch (error) {
      await maybe(() => remote.unlink(stage)).catch(() => {
        this.failed = true;
      });
      throw error;
    }
  }
  private async downloadFile(
    task: Managed,
    local: LocalFileLease,
    remote: RemoteFilesystem,
    job: Job,
  ): Promise<void> {
    const target = await this.localFile(task, local, job.localPath);
    if (!target) return;
    await ensureLocalDirectory(local, posix.dirname(target.path));
    const source = remote.readStream(job.remotePath);
    const progress = this.progress(task);
    const copying = pipeline(source, progress, { signal: task.abort.signal });
    void copying.catch(() => {});
    try {
      await local.write(target.path, progress, { overwrite: target.replace, mode: 0o600 });
      await copying;
    } finally {
      source.destroy();
      progress.destroy();
      await copying.catch(() => {});
    }
  }
  private async remoteCopy(
    task: Managed,
    request: Extract<TransferRequest, { direction: 'remote-copy' }>,
  ): Promise<void> {
    if (
      request.source.protocol === request.target.protocol &&
      request.source.connectionId === request.target.connectionId &&
      (request.sourcePath === request.targetPath ||
        descendant(request.sourcePath, request.targetPath))
    )
      throw new ApplicationError('VALIDATION_ERROR', 'A source cannot be copied into itself', 400);
    await this.withRemote(task, request.source, (source) =>
      this.withRemote(task, request.target, (target) =>
        this.replacing(task, async () => {
          const jobs: { source: string; target: string; size: number }[] = [];
          const walk = async (from: string, to: string, depth: number) => {
            if (depth > MAX_DEPTH)
              throw new ApplicationError('CAPACITY_EXCEEDED', 'Transfer depth exceeded', 503);
            const metadata = await source.lstat(from);
            this.take(task, metadata.isFile ? metadata.size : 0);
            if (metadata.isSymbolicLink) return;
            if (metadata.isFile) {
              jobs.push({ source: from, target: to, size: metadata.size });
              return;
            }
            if (!metadata.isDirectory || !request.recursive)
              throw new ApplicationError(
                'VALIDATION_ERROR',
                'Directory copy requires recursive mode',
                400,
              );
            const directory = await this.remoteDirectory(task, target, to, depth === 0);
            if (!directory) return;
            for (const entry of await source.list(from)) {
              name(entry.filename);
              if (entry.filename === '.' || entry.filename === '..' || entry.attrs.isSymbolicLink)
                continue;
              await walk(
                posix.join(from, entry.filename),
                posix.join(directory, entry.filename),
                depth + 1,
              );
            }
          };
          await walk(request.sourcePath, request.targetPath, 0);
          task.metadata = {
            ...task.metadata,
            totalBytes: jobs.reduce((sum, item) => sum + item.size, 0),
          };
          this.transition(task, 'running');
          await transferPool(jobs, task.abort.signal, (job) =>
            this.io.run(task.abort.signal, () =>
              this.withRemote(task, request.source, (read) =>
                this.withRemote(task, request.target, async (write) => {
                  const selected = await this.remoteFile(task, write, job.target);
                  if (!selected) return;
                  const stage = posix.join(
                    posix.dirname(selected.path),
                    `.axterm-${randomUUID()}.part`,
                  );
                  try {
                    await pipeline(
                      read.readStream(job.source),
                      this.progress(task),
                      write.writeStream(stage, { flags: 'wx', mode: 0o600 }),
                      { signal: task.abort.signal },
                    );
                    await this.publishRemoteFile(write, stage, selected);
                  } catch (error) {
                    await maybe(() => write.unlink(stage)).catch(() => {
                      this.failed = true;
                    });
                    throw error;
                  }
                }),
              ),
            ),
          );
        }),
      ),
    );
  }
  private async replacing(task: Managed, perform: () => Promise<void>): Promise<void> {
    try {
      await perform();
      task.abort.signal.throwIfAborted();
    } catch (error) {
      for (const replacement of task.replacements.splice(0).reverse()) {
        try {
          await replacement.rollback();
        } catch {
          this.failed = true;
        }
      }
      throw error;
    }
    let failed = false;
    let failure: unknown;
    for (const replacement of task.replacements.splice(0)) {
      try {
        await replacement.commit();
      } catch (error) {
        this.failed = true;
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
  }
  private async publishRemoteFile(
    files: RemoteFilesystem,
    stage: string,
    target: { path: string; replace: boolean; directory?: boolean },
  ): Promise<void> {
    if (!target.directory) {
      try {
        if (target.replace) await files.replace(stage, target.path);
        else await files.rename(stage, target.path);
      } catch (error) {
        if (target.replace && error instanceof RemoteFileCapabilityUnavailableError)
          throw new ApplicationError(
            'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE',
            'Atomic remote replacement is unavailable',
            503,
          );
        throw error;
      }
      return;
    }
    const backup = posix.join(posix.dirname(target.path), `.axterm-${randomUUID()}.backup`);
    await files.rename(target.path, backup);
    try {
      await files.rename(stage, target.path);
    } catch (error) {
      try {
        await files.rename(backup, target.path);
      } catch {
        this.failed = true;
      }
      throw error;
    }
    try {
      await removeRemoteTree(files, backup, { count: 0 }, 0);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  private async remoteFile(
    task: Managed,
    files: RemoteFilesystem,
    path: string,
  ): Promise<{ path: string; replace: boolean; directory?: boolean } | undefined> {
    const exists = await maybe(() => files.lstat(path));
    if (!exists) return { path, replace: false };
    const strategy = await this.conflict(task, path, 'file');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename')
      return { path: await freeName(path, (candidate) => files.lstat(candidate)), replace: false };
    return { path, replace: true, ...(exists.isDirectory ? { directory: true } : {}) };
  }
  private async remoteDirectory(
    task: Managed,
    files: RemoteFilesystem,
    path: string,
    root: boolean,
  ): Promise<string | undefined> {
    const exists = await maybe(() => files.lstat(path));
    if (!exists) {
      await ensureRemoteDirectory(files, path);
      return path;
    }
    const strategy = await this.conflict(task, path, 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename') {
      const target = await freeName(path, (candidate) => files.lstat(candidate));
      await ensureRemoteDirectory(files, target);
      return target;
    }
    if (!exists.isDirectory) {
      if (exists.isSymbolicLink)
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Cannot replace a symbolic link with a directory',
          400,
        );
      const backup = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.backup`);
      await files.rename(path, backup);
      task.replacements.push({
        commit: () => files.unlink(backup),
        rollback: async () => {
          await maybe(() => removeRemoteTree(files, path, { count: 0 }, 0));
          await files.rename(backup, path);
        },
      });
      await ensureRemoteDirectory(files, path);
    } else if (root) await ensureRemoteDirectory(files, path);
    return path;
  }
  private async localFile(
    task: Managed,
    files: LocalFileLease,
    path: string,
  ): Promise<{ path: string; replace: boolean } | undefined> {
    const exists = await maybe(() => files.stat(path));
    if (!exists) return { path, replace: false };
    const strategy = await this.conflict(task, posix.basename(path), 'file');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename')
      return { path: await freeName(path, (candidate) => files.stat(candidate)), replace: false };
    return { path, replace: true };
  }
  private async localDirectory(
    task: Managed,
    files: LocalFileLease,
    path: string,
    _root: boolean,
  ): Promise<string | undefined> {
    const exists = await maybe(() => files.stat(path));
    if (!exists) {
      await ensureLocalDirectory(files, path);
      return path;
    }
    const strategy = await this.conflict(task, posix.basename(path), 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename') {
      const target = await freeName(path, (candidate) => files.stat(candidate));
      await ensureLocalDirectory(files, target);
      return target;
    }
    if (exists.type !== 'directory') {
      if (exists.type === 'symlink')
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Cannot replace a symbolic link with a directory',
          400,
        );
      const backup = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.backup`);
      await files.move(path, backup);
      task.replacements.push({
        commit: () => files.remove(backup),
        rollback: async () => {
          await maybe(() => files.remove(path, { recursive: true }));
          await files.move(backup, path);
        },
      });
      await ensureLocalDirectory(files, path);
    }
    return path;
  }
  private async conflict(
    task: Managed,
    path: string,
    type: 'file' | 'directory' | 'unknown',
  ): Promise<Strategy> {
    const strategy = task.strategy ?? task.request.conflict;
    if (strategy !== 'ask') return strategy;
    const previous = task.metadata.state;
    task.metadata = { ...task.metadata, conflict: { path, type } };
    this.transition(task, 'awaiting-decision');
    try {
      return await new Promise<Strategy>((resolve, reject) => {
        const aborted = () => reject(new ApplicationError('REQUEST_CANCELED', 'Conflict canceled'));
        task.conflict = {
          resolve: (value) => {
            task.abort.signal.removeEventListener('abort', aborted);
            resolve(value);
          },
          reject: (error) => {
            task.abort.signal.removeEventListener('abort', aborted);
            reject(error);
          },
        };
        task.abort.signal.addEventListener('abort', aborted, { once: true });
        if (task.abort.signal.aborted) aborted();
      });
    } finally {
      delete task.conflict;
      const { conflict: _conflict, ...metadata } = task.metadata;
      task.metadata = metadata;
      if (!task.abort.signal.aborted) this.transition(task, previous);
    }
  }
  private progress(task: Managed): Transform {
    return new Transform({
      highWaterMark: 64 * 1024,
      transform: (chunk: Buffer, _encoding, done) => {
        void (async () => {
          if (task.paused) await task.waiting;
          task.abort.signal.throwIfAborted();
          const bytes = task.metadata.bytesTransferred + chunk.length;
          if (bytes > MAX_BYTES)
            throw new ApplicationError('CAPACITY_EXCEEDED', 'Transfer byte capacity exceeded', 503);
          task.metadata = {
            ...task.metadata,
            bytesTransferred: bytes,
            bytesPerSecond: bytes / Math.max((Date.now() - task.started) / 1000, 0.001),
            updatedAt: new Date().toISOString(),
          };
          this.events.publish('transfer.progress', task.metadata);
          done(null, chunk);
        })().catch((error) =>
          done(error instanceof Error ? error : new Error('Transfer interrupted')),
        );
      },
    });
  }
  private transition(task: Managed, state: Transfer['state'], errorCode?: string): void {
    const { conflict, ...rest } = task.metadata;
    task.metadata = {
      ...rest,
      ...(!['succeeded', 'failed', 'canceled'].includes(state) && conflict ? { conflict } : {}),
      state,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
    };
    this.repository.saveTransfer({
      ...task.metadata,
      source: task.metadata.source ?? '',
      destination: task.metadata.destination ?? '',
    });
    this.events.publish('transfer.progress', task.metadata);
  }
  private withRetry(transfer: Transfer): Transfer {
    if (!['failed', 'canceled'].includes(transfer.state))
      return { ...transfer, retryAvailability: 'not-terminal' };
    const request = this.requests.get(transfer.id);
    if (!request) return { ...transfer, retryAvailability: 'request-expired' };
    try {
      const ready = (target: RemoteFileTarget) =>
        target.protocol === 'ftp'
          ? this.connections.getFtp(target.connectionId).state === 'ready'
          : this.connections.get(target.connectionId).state === 'ready';
      return {
        ...transfer,
        retryAvailability:
          ready(request.target) && (request.direction !== 'remote-copy' || ready(request.source))
            ? 'available'
            : 'connection-unavailable',
      };
    } catch {
      return { ...transfer, retryAvailability: 'connection-unavailable' };
    }
  }
}
interface Job {
  localPath: string;
  remotePath: string;
  size: number;
}
function name(value: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('\0'))
    throw new ApplicationError('VALIDATION_ERROR', 'Invalid transfer member name', 400);
}
function descendant(from: string, to: string): boolean {
  const source = posix.normalize(from);
  const target = posix.normalize(to);
  return source === '/' ? target !== source : target.startsWith(source.replace(/\/$/, '') + '/');
}
async function maybe<T>(perform: () => Promise<T>): Promise<T | undefined> {
  try {
    return await perform();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const details =
      error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    if (
      ['2', 'ENOENT', 'NOT_FOUND'].includes(code) ||
      (details &&
        typeof details === 'object' &&
        'reason' in details &&
        details.reason === 'not-found')
    )
      return undefined;
    throw error;
  }
}
async function freeName(path: string, stat: (path: string) => Promise<unknown>): Promise<string> {
  for (let index = 1; index <= 999; index++) {
    const candidate = `${path}.copy-${index}`;
    if (!(await maybe(() => stat(candidate)))) return candidate;
  }
  throw new ApplicationError('TRANSFER_FAILED', 'No conflict name is available');
}
async function ensureLocalDirectory(files: LocalFileLease, path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/').filter((value) => value && value !== '.')) {
    current = current ? `${current}/${part}` : part;
    const metadata = await maybe(() => files.stat(current));
    if (!metadata) await files.mkdir(current);
    else if (metadata.type !== 'directory')
      throw new ApplicationError('VALIDATION_ERROR', 'Target parent is not a directory', 400);
  }
}
async function ensureRemoteDirectory(files: RemoteFilesystem, path: string): Promise<void> {
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = posix.join(current, part);
    const metadata = await maybe(() => files.lstat(current));
    if (!metadata) await files.mkdir(current);
    else if (!metadata.isDirectory || metadata.isSymbolicLink)
      throw new ApplicationError('VALIDATION_ERROR', 'Target parent is not a directory', 400);
  }
}
async function removeRemoteTree(
  files: RemoteFilesystem,
  path: string,
  budget: { count: number },
  depth: number,
): Promise<void> {
  if (++budget.count > MAX_ENTRIES || depth > MAX_DEPTH)
    throw new ApplicationError('CAPACITY_EXCEEDED', 'Remote conflict tree is too large', 503);
  const metadata: RemoteFileAttributes = await files.lstat(path);
  if (!metadata.isDirectory || metadata.isSymbolicLink) {
    await files.unlink(path);
    return;
  }
  for (const entry of await files.list(path)) {
    name(entry.filename);
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeRemoteTree(files, posix.join(path, entry.filename), budget, depth + 1);
  }
  await files.rmdir(path);
}
