import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { c as createTar, x as extractTar } from 'tar';
import type { Transfer, TransferConflictDecision } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { SftpHandle } from '../ports/ssh-transport';
import type { ConnectionService } from './connection-service';
import type { FtpConnectionService } from './ftp-connection-service';
import type { RealtimeHub } from './realtime-hub';
import { ApplicationError } from './errors';

interface LocalTransferRequest {
  connectionId: string;
  protocol?: 'sftp' | 'ftp';
  direction: 'upload' | 'download';
  grantId: string;
  localPath?: string | undefined;
  remotePath: string;
  recursive: boolean;
  archive?: boolean;
  conflict: 'skip' | 'overwrite' | 'rename' | 'ask';
}
interface RemoteCopyTransferRequest {
  sourceConnectionId: string;
  targetConnectionId: string;
  direction: 'remote-copy';
  sourcePath: string;
  targetPath: string;
  recursive: boolean;
  conflict: 'skip' | 'overwrite' | 'rename' | 'ask';
}
type TransferRequest = LocalTransferRequest | RemoteCopyTransferRequest;
interface ManagedTransfer {
  metadata: Transfer;
  request: TransferRequest;
  abort: AbortController;
  source: string;
  destination: string;
  appliedConflictStrategy?: TransferConflictDecision['strategy'];
  pendingConflict?: {
    resolve(strategy: TransferConflictDecision['strategy']): void;
    reject(error: unknown): void;
  };
  startedAt: number;
  paused: boolean;
  resumePaused?: () => void;
  pausePromise?: Promise<void>;
}
interface FileJob {
  localPath: string;
  remotePath: string;
  size: number;
}
interface RemoteCopyJob {
  sourcePath: string;
  targetPath: string;
  size: number;
}

const MAX_TREE_ENTRIES = 20_000;
const TRANSFER_CONCURRENCY = 4;
export const MAX_ACTIVE_TRANSFERS = 32;

export class TransferService {
  private readonly active = new Map<string, ManagedTransfer>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, TransferRequest>();
  constructor(
    private readonly connections: ConnectionService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly repository: ProductRepository,
    private readonly realtime: RealtimeHub,
    private readonly ftpConnections?: FtpConnectionService,
  ) {}

  create(request: TransferRequest, idempotencyKey: string | undefined): Transfer {
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const previous = this.repository.resolveIdempotency<Transfer>(
      idempotencyKey,
      'transfer',
      request,
    );
    if (previous && ['queued', 'preparing', 'running', 'succeeded'].includes(previous.state))
      return previous;
    if (this.active.size >= MAX_ACTIVE_TRANSFERS)
      throw new ApplicationError(
        'TRANSFER_FAILED',
        `At most ${MAX_ACTIVE_TRANSFERS} transfers may be active`,
        409,
      );
    const now = new Date().toISOString();
    const metadata: Transfer = {
      id: randomUUID(),
      connectionId:
        request.direction === 'remote-copy' ? request.sourceConnectionId : request.connectionId,
      direction: request.direction,
      state: 'queued',
      bytesTransferred: 0,
      createdAt: now,
      updatedAt: now,
    };
    const managed: ManagedTransfer = {
      metadata,
      request,
      abort: new AbortController(),
      source: describeTransferSource(request),
      destination: describeTransferDestination(request),
      startedAt: Date.now(),
      paused: false,
    };
    this.active.set(metadata.id, managed);
    this.requests.set(metadata.id, request);
    this.persist(managed);
    this.repository.recordIdempotency(idempotencyKey, 'transfer', request, metadata);
    const completion = this.run(managed);
    this.running.set(metadata.id, completion);
    void completion.finally(() => this.running.delete(metadata.id));
    return { ...metadata };
  }

  list(): Transfer[] {
    return this.repository
      .listTransfers()
      .map((item) => ({ ...item, ...(this.active.get(item.id)?.metadata ?? {}) }));
  }
  get(id: string): Transfer {
    const persisted = this.repository.getTransfer(id);
    return { ...persisted, ...(this.active.get(id)?.metadata ?? {}) };
  }
  cancel(id: string): void {
    const managed = this.active.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'Active transfer not found', 404);
    managed.paused = false;
    managed.resumePaused?.();
    delete managed.resumePaused;
    delete managed.pausePromise;
    managed.abort.abort(new Error('Transfer canceled'));
  }
  retry(id: string): Transfer {
    const request = this.requests.get(id);
    if (!request)
      throw new ApplicationError(
        'INVALID_STATE',
        'Transfer cannot be retried after a Runtime restart',
        409,
      );
    return this.create(request, randomUUID());
  }
  decideConflict(id: string, decision: TransferConflictDecision): void {
    const managed = this.active.get(id);
    if (!managed?.pendingConflict || managed.metadata.state !== 'awaiting-decision')
      throw new ApplicationError('INVALID_STATE', 'Transfer is not awaiting a decision', 409);
    if (decision.applyToAll) managed.appliedConflictStrategy = decision.strategy;
    managed.pendingConflict.resolve(decision.strategy);
  }
  pause(id: string): void {
    const managed = this.active.get(id);
    if (!managed || managed.metadata.state !== 'running')
      throw new ApplicationError('INVALID_STATE', 'Only a running transfer can be paused', 409);
    managed.paused = true;
    managed.pausePromise = new Promise<void>((resolve) => {
      managed.resumePaused = resolve;
    });
    this.transition(managed, 'paused');
  }
  resume(id: string): void {
    const managed = this.active.get(id);
    if (!managed || managed.metadata.state !== 'paused')
      throw new ApplicationError('INVALID_STATE', 'Transfer is not paused', 409);
    managed.paused = false;
    managed.resumePaused?.();
    delete managed.resumePaused;
    delete managed.pausePromise;
    this.transition(managed, 'running');
  }
  clearCompleted(): number {
    return this.repository.clearCompletedTransfers();
  }

  private async run(managed: ManagedTransfer) {
    try {
      this.transition(managed, 'preparing');
      if (managed.request.direction === 'remote-copy') await this.runRemoteCopy(managed);
      else await this.runLocalTransfer(managed);
      this.transition(managed, 'succeeded');
    } catch (error) {
      this.transition(
        managed,
        managed.abort.signal.aborted ? 'canceled' : 'failed',
        managed.abort.signal.aborted ? undefined : classifyTransferError(error),
      );
    } finally {
      this.active.delete(managed.metadata.id);
    }
  }

  private async runLocalTransfer(managed: ManagedTransfer): Promise<void> {
    const request = managed.request;
    if (request.direction === 'remote-copy')
      throw new ApplicationError('INVALID_STATE', 'Expected a local transfer request', 409);
    const host = this.requireHost();
    const grant = request.localPath
      ? await host.resolveGrantTransferPath(
          request.grantId,
          request.localPath,
          request.direction === 'upload' ? 'read' : 'write-target',
        )
      : await host.resolveGrant(request.grantId);
    if (request.direction === 'upload' && !grant.permissions.includes('read'))
      throw new ApplicationError('TRANSFER_FAILED', 'File grant does not allow reading', 409);
    if (request.direction === 'download' && !grant.permissions.includes('write'))
      throw new ApplicationError('TRANSFER_FAILED', 'File grant does not allow writing', 409);
    if (request.archive) {
      if (request.protocol === 'ftp')
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Compressed transfer is unavailable for FTP connections',
          503,
        );
      return this.runArchiveTransfer(managed, grant.path);
    }
    const sftp =
      request.protocol === 'ftp'
        ? await this.requireFtpConnections().openFiles(request.connectionId, managed.abort.signal)
        : await this.connections.handle(request.connectionId).openSftp();
    try {
      const jobs =
        request.direction === 'upload'
          ? await this.prepareUpload(
              managed,
              grant.path,
              request.remotePath,
              request.recursive,
              sftp,
            )
          : await this.prepareDownload(
              managed,
              request.remotePath,
              grant.path,
              request.recursive,
              sftp,
            );
      managed.metadata = {
        ...managed.metadata,
        totalBytes: jobs.reduce((sum, job) => sum + job.size, 0),
      };
      this.transition(managed, 'running');
      await runPool(
        jobs,
        request.conflict === 'ask' ? 1 : TRANSFER_CONCURRENCY,
        (job) =>
          request.direction === 'upload'
            ? this.uploadFile(managed, sftp, job)
            : this.downloadFile(managed, sftp, job),
        managed.abort.signal,
      );
    } finally {
      await sftp.close().catch(() => {});
    }
  }

  private requireFtpConnections(): FtpConnectionService {
    if (!this.ftpConnections)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'FTP transfers are unavailable', 503);
    return this.ftpConnections;
  }

  private async runArchiveTransfer(managed: ManagedTransfer, localPath: string): Promise<void> {
    const request = managed.request;
    if (request.direction === 'remote-copy')
      throw new ApplicationError('INVALID_STATE', 'Archive transfer requires a local side', 409);
    if (!request.recursive)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Archive transfer requires a directory source',
        400,
      );
    if (request.direction === 'upload') await this.uploadArchive(managed, localPath);
    else await this.downloadArchive(managed, localPath);
  }

  private async uploadArchive(managed: ManagedTransfer, localSource: string): Promise<void> {
    const request = managed.request;
    if (request.direction !== 'upload') throw new Error('Expected upload archive request');
    const sourceMetadata = await lstat(localSource);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink())
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Compressed upload requires a non-symlink directory',
        400,
      );
    const sourceName = basename(localSource);
    if (!sourceName)
      throw new ApplicationError('VALIDATION_ERROR', 'Filesystem root cannot be archived', 400);
    const localTemporaryRoot = await mkdtemp(join(tmpdir(), 'axterm-archive-'));
    const localArchive = join(localTemporaryRoot, 'payload.tar');
    const connection = this.connections.handle(request.connectionId);
    let sftp: SftpHandle | undefined;
    let remoteArchive = '';
    let remoteExtractRoot = '';
    try {
      await createTar(
        {
          cwd: dirname(localSource),
          file: localArchive,
          portable: true,
          filter: (_path, entry) => !('isSymbolicLink' in entry) || !entry.isSymbolicLink(),
        },
        [sourceName],
      );
      managed.abort.signal.throwIfAborted();
      const archiveMetadata = await stat(localArchive);
      sftp = await connection.openSftp();
      const targetResolution = await this.resolveRemoteArchiveTarget(
        managed,
        sftp,
        request.remotePath,
      );
      if (!targetResolution) return;
      const target = targetResolution.path;
      const id = randomUUID();
      remoteArchive = posix.join(posix.dirname(target), `.axterm-${id}.tar`);
      remoteExtractRoot = posix.join(posix.dirname(target), `.axterm-${id}.extract`);
      await sftp.mkdir(remoteExtractRoot);
      managed.metadata = { ...managed.metadata, totalBytes: archiveMetadata.size };
      this.transition(managed, 'running');
      await pipeline(
        createReadStream(localArchive),
        this.progress(managed),
        sftp.writeStream(remoteArchive, { flags: 'wx', mode: 0o600 }),
        { signal: managed.abort.signal },
      );
      const extraction = await connection.exec({
        command: remoteTarExtractCommand(remoteArchive, remoteExtractRoot),
        maxBytes: 8_192,
        signal: managed.abort.signal,
      });
      assertRemoteTarResult(extraction);
      await commitRemoteArchiveDirectory(
        sftp,
        posix.join(remoteExtractRoot, sourceName),
        target,
        targetResolution.replace,
      );
      await sftp.rmdir(remoteExtractRoot);
      remoteExtractRoot = '';
    } finally {
      await Promise.allSettled([
        remoteArchive && sftp ? sftp.unlink(remoteArchive) : Promise.resolve(),
        remoteExtractRoot && sftp ? removeRemoteEntry(sftp, remoteExtractRoot) : Promise.resolve(),
      ]);
      await sftp?.close().catch(() => {});
      await rm(localTemporaryRoot, { recursive: true, force: true });
    }
  }

  private async downloadArchive(managed: ManagedTransfer, localTarget: string): Promise<void> {
    const request = managed.request;
    if (request.direction !== 'download') throw new Error('Expected download archive request');
    const connection = this.connections.handle(request.connectionId);
    const sftp = await connection.openSftp();
    const remoteSource = request.remotePath;
    let remoteArchive = '';
    let localTemporaryRoot = '';
    try {
      const sourceMetadata = await sftp.lstat(remoteSource);
      if (!sourceMetadata.isDirectory || sourceMetadata.isSymbolicLink)
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'Compressed download requires a non-symlink directory',
          400,
        );
      const sourceName = posix.basename(remoteSource);
      if (!sourceName || remoteSource === '/')
        throw new ApplicationError('VALIDATION_ERROR', 'Filesystem root cannot be archived', 400);
      const targetResolution = await this.resolveLocalArchiveTarget(managed, localTarget);
      if (!targetResolution) return;
      const target = targetResolution.path;
      remoteArchive = `/tmp/.axterm-${randomUUID()}.tar`;
      const creation = await connection.exec({
        command: remoteTarCreateCommand(remoteSource, remoteArchive),
        maxBytes: 8_192,
        signal: managed.abort.signal,
      });
      assertRemoteTarResult(creation);
      const archiveMetadata = await sftp.stat(remoteArchive);
      localTemporaryRoot = await mkdtemp(join(dirname(target), '.axterm-extract-'));
      const localArchive = join(localTemporaryRoot, 'payload.tar');
      managed.metadata = { ...managed.metadata, totalBytes: archiveMetadata.size };
      this.transition(managed, 'running');
      await pipeline(
        sftp.readStream(remoteArchive),
        this.progress(managed),
        createWriteStream(localArchive, { flags: 'wx', mode: 0o600 }),
        { signal: managed.abort.signal },
      );
      await extractTar({
        cwd: localTemporaryRoot,
        file: localArchive,
        preservePaths: false,
        strict: true,
        filter: (_path, entry) =>
          !('type' in entry) || !['SymbolicLink', 'Link'].includes(entry.type),
      });
      await commitLocalArchiveDirectory(
        join(localTemporaryRoot, sourceName),
        target,
        targetResolution.replace,
      );
    } finally {
      if (remoteArchive) await sftp.unlink(remoteArchive).catch(() => {});
      await sftp.close().catch(() => {});
      if (localTemporaryRoot)
        await rm(localTemporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async resolveRemoteArchiveTarget(
    managed: ManagedTransfer,
    sftp: SftpHandle,
    path: string,
  ): Promise<{ path: string; replace: boolean } | undefined> {
    const existing = await sftp.lstat(path).catch(() => undefined);
    if (!existing) return { path, replace: false };
    const strategy = await this.resolveConflictStrategy(managed, path, 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename') {
      const renamed = await resolveRemoteConflict(sftp, path, 'rename');
      return renamed ? { path: renamed, replace: false } : undefined;
    }
    return { path, replace: true };
  }

  private async resolveLocalArchiveTarget(
    managed: ManagedTransfer,
    path: string,
  ): Promise<{ path: string; replace: boolean } | undefined> {
    const existing = await lstat(path).catch(() => undefined);
    if (!existing) return { path, replace: false };
    const strategy = await this.resolveConflictStrategy(managed, basename(path), 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename') {
      const renamed = await resolveLocalConflict(path, 'rename');
      return renamed ? { path: renamed, replace: false } : undefined;
    }
    return { path, replace: true };
  }

  private async runRemoteCopy(managed: ManagedTransfer): Promise<void> {
    const request = managed.request;
    if (request.direction !== 'remote-copy')
      throw new ApplicationError('INVALID_STATE', 'Expected a remote transfer request', 409);
    if (
      request.sourceConnectionId === request.targetConnectionId &&
      isRemoteDescendant(request.sourcePath, request.targetPath)
    )
      throw new ApplicationError(
        'TRANSFER_FAILED',
        'A remote directory cannot be copied into its own descendant',
        409,
      );
    const source = await this.connections.handle(request.sourceConnectionId).openSftp();
    let target: SftpHandle | undefined;
    try {
      target = await this.connections.handle(request.targetConnectionId).openSftp();
      const jobs = await this.prepareRemoteCopy(
        managed,
        request.sourcePath,
        request.targetPath,
        request.recursive,
        source,
        target,
      );
      managed.metadata = {
        ...managed.metadata,
        totalBytes: jobs.reduce((sum, job) => sum + job.size, 0),
      };
      this.transition(managed, 'running');
      await runPool(
        jobs,
        request.conflict === 'ask' ? 1 : TRANSFER_CONCURRENCY,
        (job) => this.copyRemoteFile(managed, source, target!, job),
        managed.abort.signal,
      );
    } finally {
      await Promise.allSettled([source.close(), target?.close()]);
    }
  }

  private async prepareRemoteCopy(
    managed: ManagedTransfer,
    sourcePath: string,
    targetPath: string,
    recursive: boolean,
    source: SftpHandle,
    target: SftpHandle,
  ): Promise<RemoteCopyJob[]> {
    const root = await source.lstat(sourcePath);
    if (root.isSymbolicLink) return [];
    if (root.isFile) return [{ sourcePath, targetPath, size: root.size }];
    if (!root.isDirectory || !recursive)
      throw new ApplicationError(
        'TRANSFER_FAILED',
        'A directory transfer requires recursive mode',
        409,
      );
    const resolvedRoot = await this.resolveRemoteDirectoryTarget(managed, target, targetPath, true);
    if (!resolvedRoot) return [];
    const jobs: RemoteCopyJob[] = [];
    let entryCount = 0;
    const walk = async (sourceDirectory: string, targetDirectory: string) => {
      for (const entry of await source.list(sourceDirectory)) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (++entryCount > MAX_TREE_ENTRIES)
          throw new ApplicationError('TRANSFER_FAILED', 'Directory contains too many entries', 409);
        const nextSource = posix.join(sourceDirectory, entry.filename);
        const nextTarget = posix.join(targetDirectory, entry.filename);
        if (entry.attrs.isSymbolicLink) continue;
        if (entry.attrs.isDirectory) {
          const resolvedDirectory = await this.resolveRemoteDirectoryTarget(
            managed,
            target,
            nextTarget,
            false,
          );
          if (resolvedDirectory) await walk(nextSource, resolvedDirectory);
        } else if (entry.attrs.isFile)
          jobs.push({ sourcePath: nextSource, targetPath: nextTarget, size: entry.attrs.size });
      }
    };
    await walk(sourcePath, resolvedRoot);
    return jobs;
  }

  private async copyRemoteFile(
    managed: ManagedTransfer,
    source: SftpHandle,
    target: SftpHandle,
    job: RemoteCopyJob,
  ): Promise<void> {
    const destination = await this.resolveRemoteFileTarget(managed, target, job.targetPath);
    if (!destination) return;
    const temporary = posix.join(posix.dirname(destination), `.axterm-${randomUUID()}.part`);
    try {
      await pipeline(
        source.readStream(job.sourcePath),
        this.progress(managed),
        target.writeStream(temporary, { flags: 'wx', mode: 0o600 }),
        { signal: managed.abort.signal },
      );
      await target.rename(temporary, destination);
    } catch (error) {
      await target.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async prepareUpload(
    managed: ManagedTransfer,
    localPath: string,
    remotePath: string,
    recursive: boolean,
    sftp: SftpHandle,
  ): Promise<FileJob[]> {
    const root = await lstat(localPath);
    if (root.isSymbolicLink()) return [];
    if (root.isFile()) return [{ localPath, remotePath, size: root.size }];
    if (!root.isDirectory() || !recursive)
      throw new ApplicationError(
        'TRANSFER_FAILED',
        'A directory transfer requires recursive mode',
        409,
      );
    const resolvedRoot = await this.resolveRemoteDirectoryTarget(managed, sftp, remotePath, true);
    if (!resolvedRoot) return [];
    const jobs: FileJob[] = [];
    const walk = async (localDirectory: string, remoteDirectory: string) => {
      for (const entry of await readdir(localDirectory, { withFileTypes: true })) {
        if (++entryCount > MAX_TREE_ENTRIES)
          throw new ApplicationError('TRANSFER_FAILED', 'Directory contains too many entries', 409);
        const local = join(localDirectory, entry.name);
        const remote = posix.join(remoteDirectory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const resolvedDirectory = await this.resolveRemoteDirectoryTarget(
            managed,
            sftp,
            remote,
            false,
          );
          if (resolvedDirectory) await walk(local, resolvedDirectory);
        } else if (entry.isFile())
          jobs.push({ localPath: local, remotePath: remote, size: (await stat(local)).size });
      }
    };
    let entryCount = 0;
    await walk(localPath, resolvedRoot);
    return jobs;
  }

  private async prepareDownload(
    managed: ManagedTransfer,
    remotePath: string,
    localPath: string,
    recursive: boolean,
    sftp: SftpHandle,
  ): Promise<FileJob[]> {
    const root = await sftp.lstat(remotePath);
    if (root.isSymbolicLink) return [];
    if (root.isFile) return [{ localPath, remotePath, size: root.size }];
    if (!root.isDirectory || !recursive)
      throw new ApplicationError(
        'TRANSFER_FAILED',
        'A directory transfer requires recursive mode',
        409,
      );
    await mkdir(localPath, { recursive: true, mode: 0o700 });
    const jobs: FileJob[] = [];
    let entryCount = 0;
    const walk = async (remoteDirectory: string, localDirectory: string) => {
      for (const entry of await sftp.list(remoteDirectory)) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (++entryCount > MAX_TREE_ENTRIES)
          throw new ApplicationError('TRANSFER_FAILED', 'Directory contains too many entries', 409);
        const remote = posix.join(remoteDirectory, entry.filename);
        const local = join(localDirectory, entry.filename);
        if (entry.attrs.isSymbolicLink) continue;
        if (entry.attrs.isDirectory) {
          const resolvedDirectory = await this.resolveLocalDirectoryTarget(managed, local, false);
          if (resolvedDirectory) await walk(remote, resolvedDirectory);
        } else if (entry.attrs.isFile)
          jobs.push({ localPath: local, remotePath: remote, size: entry.attrs.size });
      }
    };
    await walk(remotePath, localPath);
    return jobs;
  }

  private async uploadFile(managed: ManagedTransfer, sftp: SftpHandle, job: FileJob) {
    const target = await this.resolveRemoteFileTarget(managed, sftp, job.remotePath);
    if (!target) return;
    const temporary = posix.join(posix.dirname(target), `.axterm-${randomUUID()}.part`);
    try {
      await pipeline(
        createReadStream(job.localPath),
        this.progress(managed),
        sftp.writeStream(temporary, { flags: 'wx', mode: 0o600 }),
        { signal: managed.abort.signal },
      );
      await sftp.rename(temporary, target);
    } catch (error) {
      await sftp.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async downloadFile(managed: ManagedTransfer, sftp: SftpHandle, job: FileJob) {
    const target = await this.resolveLocalFileTarget(managed, job.localPath);
    if (!target) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.axterm-${randomUUID()}.part`;
    try {
      await pipeline(
        sftp.readStream(job.remotePath),
        this.progress(managed),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        { signal: managed.abort.signal },
      );
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async resolveRemoteFileTarget(
    managed: ManagedTransfer,
    sftp: SftpHandle,
    path: string,
  ): Promise<string | undefined> {
    const existing = await sftp.lstat(path).catch(() => undefined);
    if (!existing) return path;
    const strategy = await this.resolveConflictStrategy(managed, path, 'file');
    if (strategy === 'overwrite' && existing.isDirectory) await removeRemoteEntry(sftp, path);
    return resolveRemoteConflict(sftp, path, strategy);
  }

  private async resolveRemoteDirectoryTarget(
    managed: ManagedTransfer,
    sftp: SftpHandle,
    path: string,
    root: boolean,
  ): Promise<string | undefined> {
    const existing = await sftp.lstat(path).catch(() => undefined);
    const strategy = existing
      ? await this.resolveConflictStrategy(managed, path, 'directory')
      : ('overwrite' as const);
    return resolveRemoteDirectoryConflict(sftp, path, strategy, root);
  }

  private async resolveLocalFileTarget(
    managed: ManagedTransfer,
    path: string,
  ): Promise<string | undefined> {
    const existing = await lstat(path).catch(() => undefined);
    if (!existing) return path;
    const strategy = await this.resolveConflictStrategy(managed, basename(path), 'file');
    if (strategy === 'overwrite' && existing.isDirectory()) await rm(path, { recursive: true });
    return resolveLocalConflict(path, strategy);
  }

  private async resolveLocalDirectoryTarget(
    managed: ManagedTransfer,
    path: string,
    root: boolean,
  ): Promise<string | undefined> {
    const existing = await lstat(path).catch(() => undefined);
    if (!existing) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    }
    const strategy = await this.resolveConflictStrategy(managed, basename(path), 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'rename') {
      const renamed = await resolveLocalConflict(path, 'rename');
      if (renamed) await mkdir(renamed, { recursive: true, mode: 0o700 });
      return renamed;
    }
    if (!existing.isDirectory()) {
      await unlink(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
    } else if (root) await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  private async resolveConflictStrategy(
    managed: ManagedTransfer,
    path: string,
    type: NonNullable<Transfer['conflict']>['type'],
  ): Promise<TransferConflictDecision['strategy']> {
    const selected = effectiveConflictStrategy(managed);
    if (selected !== 'ask') return selected;
    const previousState = managed.metadata.state;
    managed.metadata = {
      ...managed.metadata,
      state: 'awaiting-decision',
      conflict: { path, type },
      updatedAt: new Date().toISOString(),
    };
    this.persist(managed);
    this.realtime.publish('transfer.progress', managed.metadata);
    try {
      const strategy = await new Promise<TransferConflictDecision['strategy']>(
        (resolve, reject) => {
          const onAbort = () =>
            reject(managed.abort.signal.reason ?? new Error('Transfer canceled'));
          managed.pendingConflict = {
            resolve: (value) => {
              managed.abort.signal.removeEventListener('abort', onAbort);
              resolve(value);
            },
            reject: (error) => {
              managed.abort.signal.removeEventListener('abort', onAbort);
              reject(error);
            },
          };
          managed.abort.signal.addEventListener('abort', onAbort, { once: true });
          if (managed.abort.signal.aborted) onAbort();
        },
      );
      const { conflict: _conflict, ...metadata } = managed.metadata;
      managed.metadata = {
        ...metadata,
        state: previousState,
        updatedAt: new Date().toISOString(),
      };
      this.persist(managed);
      this.realtime.publish('transfer.progress', managed.metadata);
      return strategy;
    } finally {
      delete managed.pendingConflict;
    }
  }

  private progress(managed: ManagedTransfer) {
    return new Transform({
      transform: (chunk, _encoding, callback) => {
        void this.waitUntilResumed(managed).then(
          () => {
            managed.abort.signal.throwIfAborted();
            const bytesTransferred = managed.metadata.bytesTransferred + Buffer.byteLength(chunk);
            const elapsedSeconds = Math.max((Date.now() - managed.startedAt) / 1_000, 0.001);
            managed.metadata = {
              ...managed.metadata,
              bytesTransferred,
              bytesPerSecond: bytesTransferred / elapsedSeconds,
              updatedAt: new Date().toISOString(),
            };
            this.realtime.publish('transfer.progress', managed.metadata);
            callback(null, chunk);
          },
          (error) => callback(error instanceof Error ? error : new Error('Transfer interrupted')),
        );
      },
    });
  }
  private async waitUntilResumed(managed: ManagedTransfer): Promise<void> {
    if (managed.paused && managed.pausePromise) await managed.pausePromise;
  }
  private transition(managed: ManagedTransfer, state: Transfer['state'], errorCode?: string) {
    const terminal = ['succeeded', 'failed', 'canceled'].includes(state);
    const { conflict: _conflict, ...withoutConflict } = managed.metadata;
    managed.metadata = {
      ...(terminal ? withoutConflict : managed.metadata),
      state,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
    };
    this.persist(managed);
    this.realtime.publish('transfer.progress', managed.metadata);
  }
  private persist(managed: ManagedTransfer) {
    this.repository.saveTransfer({
      ...managed.metadata,
      source: managed.source,
      destination: managed.destination,
    });
  }
  private requireHost() {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    return this.host;
  }
  async closeAll() {
    for (const transfer of this.active.values()) transfer.abort.abort();
    await Promise.allSettled(this.running.values());
  }
  resourceCount() {
    return this.active.size;
  }
}

async function ensureRemoteDirectory(sftp: SftpHandle, path: string) {
  let current = '/';
  for (const part of path.split('/').filter(Boolean)) {
    current = posix.join(current, part);
    try {
      const attrs = await sftp.stat(current);
      if (!attrs.isDirectory) throw new Error('Remote path is not a directory');
    } catch {
      await sftp.mkdir(current).catch(async () => {
        if (!(await sftp.stat(current)).isDirectory)
          throw new Error('Remote directory could not be created');
      });
    }
  }
}
async function removeRemoteEntry(
  sftp: SftpHandle,
  path: string,
  counter = { value: 0 },
): Promise<void> {
  if (++counter.value > MAX_TREE_ENTRIES)
    throw new ApplicationError('TRANSFER_FAILED', 'Remote conflict contains too many entries', 409);
  const attributes = await sftp.lstat(path);
  if (!attributes.isDirectory || attributes.isSymbolicLink) {
    await sftp.unlink(path);
    return;
  }
  for (const entry of await sftp.list(path)) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeRemoteEntry(sftp, posix.join(path, entry.filename), counter);
  }
  await sftp.rmdir(path);
}
async function commitRemoteArchiveDirectory(
  sftp: SftpHandle,
  source: string,
  target: string,
  replace: boolean,
): Promise<void> {
  if (!replace) {
    await sftp.rename(source, target);
    return;
  }
  const backup = posix.join(posix.dirname(target), `.axterm-${randomUUID()}.backup`);
  await sftp.rename(target, backup);
  try {
    await sftp.rename(source, target);
  } catch (error) {
    await sftp.rename(backup, target).catch(() => {});
    throw error;
  }
  await removeRemoteEntry(sftp, backup);
}
async function commitLocalArchiveDirectory(
  source: string,
  target: string,
  replace: boolean,
): Promise<void> {
  if (!replace) {
    await rename(source, target);
    return;
  }
  const backup = join(dirname(target), `.axterm-${randomUUID()}.backup`);
  await rename(target, backup);
  try {
    await rename(source, target);
  } catch (error) {
    await rename(backup, target).catch(() => {});
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}
async function resolveRemoteDirectoryConflict(
  sftp: SftpHandle,
  path: string,
  conflict: TransferConflictDecision['strategy'],
  root: boolean,
): Promise<string | undefined> {
  const existing = await sftp.lstat(path).catch(() => undefined);
  if (!existing) {
    await ensureRemoteDirectory(sftp, path);
    return path;
  }
  if (existing.isDirectory) {
    if (root && conflict === 'skip') return undefined;
    if (root && conflict === 'rename') {
      const renamed = await resolveRemoteConflict(sftp, path, 'rename');
      if (renamed) await ensureRemoteDirectory(sftp, renamed);
      return renamed;
    }
    if (!root && conflict === 'skip') return undefined;
    if (!root && conflict === 'rename') {
      const renamed = await resolveRemoteConflict(sftp, path, 'rename');
      if (renamed) await ensureRemoteDirectory(sftp, renamed);
      return renamed;
    }
    return path;
  }
  if (conflict === 'skip') return undefined;
  const destination =
    conflict === 'rename' ? await resolveRemoteConflict(sftp, path, 'rename') : path;
  if (!destination) return undefined;
  if (destination === path) await sftp.unlink(path);
  await ensureRemoteDirectory(sftp, destination);
  return destination;
}
async function resolveRemoteConflict(
  sftp: SftpHandle,
  path: string,
  conflict: TransferConflictDecision['strategy'],
): Promise<string | undefined> {
  const exists = await sftp.lstat(path).then(
    () => true,
    () => false,
  );
  if (!exists) return path;
  if (conflict === 'skip') return undefined;
  if (conflict === 'overwrite') return path;
  for (let index = 1; index <= 999; index++) {
    const candidate = `${path}.copy-${index}`;
    if (
      !(await sftp.lstat(candidate).then(
        () => true,
        () => false,
      ))
    )
      return candidate;
  }
  throw new ApplicationError('TRANSFER_FAILED', 'No available conflict name', 409);
}
async function resolveLocalConflict(
  path: string,
  conflict: TransferConflictDecision['strategy'],
): Promise<string | undefined> {
  const exists = await lstat(path).then(
    () => true,
    () => false,
  );
  if (!exists) return path;
  if (conflict === 'skip') return undefined;
  if (conflict === 'overwrite') return path;
  for (let index = 1; index <= 999; index++) {
    const candidate = `${path}.copy-${index}`;
    if (
      !(await lstat(candidate).then(
        () => true,
        () => false,
      ))
    )
      return candidate;
  }
  throw new ApplicationError('TRANSFER_FAILED', 'No available conflict name', 409);
}
async function runPool<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
  signal: AbortSignal,
) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      signal.throwIfAborted();
      const item = items[cursor++];
      if (item) await operation(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
function classifyTransferError(error: unknown) {
  return error instanceof ApplicationError ? error.code : 'TRANSFER_FAILED';
}

function quoteRemoteShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function remoteTarCreateCommand(source: string, archive: string): string {
  const parent = posix.dirname(source);
  const name = posix.basename(source);
  return `umask 077; command -v tar >/dev/null 2>&1 || exit 127; tar -C ${quoteRemoteShell(parent)} -cf ${quoteRemoteShell(archive)} ${quoteRemoteShell(`./${name}`)}`;
}

function remoteTarExtractCommand(archive: string, destination: string): string {
  return `command -v tar >/dev/null 2>&1 || exit 127; tar -xf ${quoteRemoteShell(archive)} -C ${quoteRemoteShell(destination)}`;
}

function assertRemoteTarResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): void {
  if (result.exitCode === 0) return;
  if (result.exitCode === 127)
    throw new ApplicationError(
      'CAPABILITY_UNAVAILABLE',
      'The remote host does not provide the tar archive tool',
      503,
    );
  throw new ApplicationError('TRANSFER_FAILED', 'Remote archive command failed', 409);
}

function effectiveConflictStrategy(
  managed: ManagedTransfer,
): TransferConflictDecision['strategy'] | 'ask' {
  return managed.appliedConflictStrategy ?? managed.request.conflict;
}

function describeTransferSource(request: TransferRequest): string {
  if (request.direction === 'remote-copy')
    return `${request.sourceConnectionId}:${request.sourcePath}`;
  return request.direction === 'upload'
    ? `${request.grantId}${request.localPath ? `:${request.localPath}` : ''}`
    : request.remotePath;
}

function describeTransferDestination(request: TransferRequest): string {
  if (request.direction === 'remote-copy')
    return `${request.targetConnectionId}:${request.targetPath}`;
  return request.direction === 'upload'
    ? request.remotePath
    : `${request.grantId}${request.localPath ? `:${request.localPath}` : ''}`;
}

function isRemoteDescendant(sourcePath: string, targetPath: string): boolean {
  const source = sourcePath === '/' ? '/' : sourcePath.replace(/\/$/, '');
  return targetPath !== source && targetPath.startsWith(`${source === '/' ? '' : source}/`);
}
