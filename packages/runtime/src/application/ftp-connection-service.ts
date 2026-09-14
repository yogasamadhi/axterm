import { randomUUID } from 'node:crypto';
import type { Bookmark, FtpConnection } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { FtpFileHandle, FtpTransport } from '../ports/ftp-transport';
import type { SftpHandle } from '../ports/ssh-transport';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionProfileService } from './connection-profile-service';
import { ApplicationError } from './errors';

interface ManagedFtpConnection {
  metadata: FtpConnection;
  bookmark: Bookmark;
  credentialRef: string | null;
  handles: Set<FtpFileHandle>;
}

export class FtpConnectionService {
  private readonly connections = new Map<string, ManagedFtpConnection>();

  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly profiles: ConnectionProfileService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly transport: FtpTransport,
  ) {}

  list(): FtpConnection[] {
    return [...this.connections.values()].map(({ metadata }) => ({ ...metadata }));
  }

  get(id: string): FtpConnection {
    return { ...this.require(id).metadata };
  }

  async create(bookmarkId: string, signal?: AbortSignal): Promise<FtpConnection> {
    const bookmark = this.bookmarks.getBookmark(bookmarkId);
    if (bookmark.protocol !== 'ftp' || !bookmark.ftp)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not an FTP destination', 400);
    const profile = bookmark.connectionProfileId
      ? this.profiles.get(bookmark.connectionProfileId).ftp
      : undefined;
    const settings = bookmark.ftp;
    const username = profile?.username ?? settings.username;
    const credentialRef = profile?.passwordCredentialRef ?? settings.credentialRef;
    const now = new Date().toISOString();
    const metadata: FtpConnection = {
      id: randomUUID(),
      bookmarkId,
      name: bookmark.title,
      hostname: settings.hostname,
      port: settings.port,
      username,
      security: settings.security,
      encoding: settings.encoding,
      initialDirectory: settings.initialDirectory,
      state: 'connecting',
      createdAt: now,
      updatedAt: now,
    };
    const managed: ManagedFtpConnection = {
      metadata,
      bookmark,
      credentialRef,
      handles: new Set(),
    };
    this.connections.set(metadata.id, managed);
    try {
      const handle = await this.open(managed, signal);
      await handle.close();
      managed.metadata = {
        ...managed.metadata,
        state: 'ready',
        updatedAt: new Date().toISOString(),
      };
      return { ...managed.metadata };
    } catch {
      managed.metadata = {
        ...managed.metadata,
        state: 'failed',
        errorCode: 'FTP_CONNECTION_FAILED',
        updatedAt: new Date().toISOString(),
      };
      throw new ApplicationError('FTP_CONNECTION_FAILED', 'FTP connection failed', 503);
    }
  }

  async openFiles(id: string, signal?: AbortSignal): Promise<SftpHandle> {
    const managed = this.require(id);
    if (managed.metadata.state !== 'ready')
      throw new ApplicationError('INVALID_STATE', 'FTP connection is not ready', 409);
    const handle = await this.open(managed, signal);
    managed.handles.add(handle);
    return trackedHandle(handle, () => managed.handles.delete(handle));
  }

  async close(id: string): Promise<void> {
    const managed = this.require(id);
    managed.metadata = {
      ...managed.metadata,
      state: 'closing',
      updatedAt: new Date().toISOString(),
    };
    await Promise.allSettled([...managed.handles].map((handle) => handle.close()));
    managed.handles.clear();
    managed.metadata = {
      ...managed.metadata,
      state: 'closed',
      updatedAt: new Date().toISOString(),
    };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()]
        .filter(({ metadata }) => metadata.state !== 'closed')
        .map(({ metadata }) => this.close(metadata.id)),
    );
  }

  resourceCount(): number {
    return [...this.connections.values()].reduce(
      (count, connection) =>
        count + (connection.metadata.state === 'ready' ? 1 : 0) + connection.handles.size,
      0,
    );
  }

  private async open(managed: ManagedFtpConnection, signal?: AbortSignal): Promise<FtpFileHandle> {
    const password = managed.credentialRef
      ? await this.requireHost().resolveCredential(managed.credentialRef)
      : undefined;
    const settings = managed.bookmark.ftp!;
    const handle = await this.transport.connect({
      host: managed.metadata.hostname,
      port: managed.metadata.port,
      username: managed.metadata.username,
      ...(password === undefined ? {} : { password }),
      security: managed.metadata.security,
      tlsVerify: settings.tlsVerify,
      encoding: managed.metadata.encoding,
      ...(signal ? { signal } : {}),
      timeoutMs: 30_000,
    });
    try {
      if (managed.metadata.initialDirectory !== '/')
        await handle.cd(managed.metadata.initialDirectory);
      else await handle.pwd();
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private require(id: string): ManagedFtpConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new ApplicationError('NOT_FOUND', 'FTP connection not found', 404);
    return connection;
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Local credential storage is unavailable',
        503,
      );
    return this.host;
  }
}

function trackedHandle(handle: FtpFileHandle, onClose: () => void): FtpFileHandle {
  let closed = false;
  return {
    pwd: () => handle.pwd(),
    cd: (path) => handle.cd(path),
    realpath: (path) => handle.realpath(path),
    list: (path) => handle.list(path),
    stat: (path) => handle.stat(path),
    lstat: (path) => handle.lstat(path),
    mkdir: (path) => handle.mkdir(path),
    rename: (from, to) => handle.rename(from, to),
    replace: (from, to) => handle.replace(from, to),
    unlink: (path) => handle.unlink(path),
    rmdir: (path) => handle.rmdir(path),
    chmod: (path, mode) => handle.chmod(path, mode),
    readStream: (path, options) => handle.readStream(path, options),
    writeStream: (path, options) => handle.writeStream(path, options),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } finally {
        onClose();
      }
    },
  };
}
