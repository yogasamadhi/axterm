import { randomUUID } from 'node:crypto';
import type { CatalogQueries } from '@axterm/plugin-api/host';
import type { Bookmark } from '@axterm/plugin-api/catalog';
import type { FtpConnection } from '@axterm/plugin-api/connections';
import type { RemoteFileLease } from '@axterm/plugin-api/host';
import type { FtpTransport } from '../ports/ftp-transport.ts';
import type { CredentialAccess } from '../ports/credentials.ts';
import type { RemoteFileLeaseFactory } from '../ports/file-leases.ts';
import { ApplicationError } from './errors.ts';

interface ManagedFtp {
  metadata: FtpConnection;
  bookmark: Bookmark;
  credentialRef: string | null;
  lifetime: AbortController;
  leases: Set<RemoteFileLease>;
  pending: Set<Promise<unknown>>;
  cleanupFailed: boolean;
  closing?: Promise<void>;
}
/** Logical FTP sessions own every independently authenticated filesystem channel. */
export class FtpConnectionService {
  private readonly connections = new Map<string, ManagedFtp>();
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  private opening = 0;
  constructor(
    private readonly catalog: Pick<CatalogQueries, 'getBookmark' | 'getConnectionProfile'>,
    private readonly credentials: Pick<CredentialAccess, 'resolveCredential'>,
    private readonly transport: FtpTransport,
    private readonly lease: RemoteFileLeaseFactory,
    private readonly changed: () => void,
  ) {}
  list(): FtpConnection[] {
    return [...this.connections.values()].map((item) => ({ ...item.metadata }));
  }
  get(id: string): FtpConnection {
    return { ...this.require(id).metadata };
  }
  create(
    bookmarkId: string,
    signal?: AbortSignal,
    allocated?: (id: string) => void,
  ): Promise<FtpConnection> {
    try {
      this.admit();
      signal?.throwIfAborted();
      this.prune();
      if (
        [...this.connections.values()].filter(
          (item) =>
            !['closed', 'failed'].includes(item.metadata.state) ||
            item.cleanupFailed ||
            item.leases.size ||
            item.pending.size,
        ).length >= 64 ||
        this.connections.size >= 10_000
      )
        throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP session capacity exceeded', 503);
      const bookmark = this.catalog.getBookmark(bookmarkId);
      if (bookmark.protocol !== 'ftp' || !bookmark.ftp)
        throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not an FTP destination', 400);
      const profile = bookmark.connectionProfileId
        ? this.catalog.getConnectionProfile(bookmark.connectionProfileId).ftp
        : undefined;
      const now = new Date().toISOString();
      const managed: ManagedFtp = {
        metadata: {
          id: randomUUID(),
          bookmarkId,
          name: bookmark.title,
          hostname: bookmark.ftp.hostname,
          port: bookmark.ftp.port,
          username: profile?.username ?? bookmark.ftp.username,
          security: bookmark.ftp.security,
          encoding: bookmark.ftp.encoding,
          initialDirectory: bookmark.ftp.initialDirectory,
          state: 'connecting',
          createdAt: now,
          updatedAt: now,
        },
        bookmark,
        credentialRef: profile?.passwordCredentialRef ?? bookmark.ftp.credentialRef,
        lifetime: new AbortController(),
        leases: new Set(),
        pending: new Set(),
        cleanupFailed: false,
      };
      this.connections.set(managed.metadata.id, managed);
      try {
        allocated?.(managed.metadata.id);
      } catch (error) {
        this.connections.delete(managed.metadata.id);
        throw error;
      }
      this.changed();
      const lifetime = this.signal(managed, signal);
      return this.track(
        managed,
        (async () => {
          try {
            const lease = await this.open(managed, lifetime);
            await lease.close();
            lifetime.throwIfAborted();
            this.transition(managed, 'ready');
            return { ...managed.metadata };
          } catch (error) {
            if (!managed.lifetime.signal.aborted)
              this.transition(
                managed,
                'failed',
                lifetime.aborted ? 'REQUEST_CANCELED' : 'FTP_CONNECTION_FAILED',
              );
            if (lifetime.aborted)
              throw new ApplicationError('REQUEST_CANCELED', 'FTP connection was canceled', 409);
            if (error instanceof ApplicationError) throw error;
            throw new ApplicationError('FTP_CONNECTION_FAILED', 'FTP connection failed', 503);
          }
        })(),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  openFiles(id: string, signal?: AbortSignal): Promise<RemoteFileLease> {
    try {
      this.admit();
      const managed = this.require(id);
      if (managed.metadata.state !== 'ready')
        throw new ApplicationError('INVALID_STATE', 'FTP connection is not ready', 409);
      return this.track(managed, this.open(managed, this.signal(managed, signal)));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  close(id: string): Promise<void> {
    const managed = this.connections.get(id);
    if (!managed || managed.metadata.state === 'closed') return Promise.resolve();
    if (managed.closing) return managed.closing;
    const deferred = Promise.withResolvers<void>();
    managed.closing = deferred.promise;
    this.transition(managed, 'closing');
    managed.lifetime.abort();
    void (async () => {
      const results = await Promise.allSettled([...managed.leases].map((lease) => lease.close()));
      await Promise.allSettled([...managed.pending]);
      if (
        managed.cleanupFailed ||
        managed.leases.size ||
        results.some((item) => item.status === 'rejected')
      )
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'FTP resources did not drain', 503);
      this.transition(managed, 'closed');
      this.prune();
    })().then(
      () => deferred.resolve(),
      (error) => deferred.reject(error),
    );
    return deferred.promise;
  }
  async closeAll(): Promise<void> {
    this.accepting = false;
    const results = await Promise.allSettled(
      [...this.connections.keys()].map((id) => this.close(id)),
    );
    await Promise.allSettled([...this.pending]);
    if (results.some((item) => item.status === 'rejected'))
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'FTP sessions did not drain', 503);
  }
  activeTaskCount(): number {
    return (
      this.pending.size +
      [...this.connections.values()].filter(
        (item) =>
          !['closed', 'failed'].includes(item.metadata.state) ||
          item.leases.size ||
          item.cleanupFailed,
      ).length
    );
  }
  resourceCount(): number {
    return [...this.connections.values()].reduce(
      (count, item) =>
        count +
        (item.metadata.state === 'ready' ? 1 : 0) +
        item.leases.size +
        item.pending.size +
        (item.cleanupFailed ? 1 : 0),
      0,
    );
  }
  private async open(managed: ManagedFtp, signal: AbortSignal): Promise<RemoteFileLease> {
    signal.throwIfAborted();
    if (
      this.opening >= 64 ||
      this.opening +
        [...this.connections.values()].reduce((count, item) => count + item.leases.size, 0) >=
        256
    )
      throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP channel capacity exceeded', 503);
    this.opening++;
    try {
      const password = managed.credentialRef
        ? await this.credentials.resolveCredential(managed.credentialRef, signal)
        : undefined;
      signal.throwIfAborted();
      const native = await this.transport.connect({
        host: managed.metadata.hostname,
        port: managed.metadata.port,
        username: managed.metadata.username,
        ...(password === undefined ? {} : { password }),
        security: managed.metadata.security,
        tlsVerify: managed.bookmark.ftp!.tlsVerify,
        encoding: managed.metadata.encoding,
        signal,
        timeoutMs: 30_000,
      });
      if (signal.aborted) {
        try {
          await native.close();
        } catch {
          managed.cleanupFailed = true;
          throw new ApplicationError(
            'CAPABILITY_UNAVAILABLE',
            'Late FTP channel did not drain',
            503,
          );
        }
        throw new ApplicationError('REQUEST_CANCELED', 'FTP opening was canceled', 409);
      }
      const lease = this.lease(native, signal, () => managed.leases.delete(lease));
      managed.leases.add(lease);
      try {
        if (managed.metadata.initialDirectory !== '/')
          await native.cd(managed.metadata.initialDirectory);
        else await native.pwd();
        signal.throwIfAborted();
        return lease;
      } catch (error) {
        await lease.close();
        throw error;
      }
    } finally {
      this.opening--;
    }
  }
  private signal(managed: ManagedFtp, signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([managed.lifetime.signal, signal]) : managed.lifetime.signal;
  }
  private track<T>(managed: ManagedFtp, pending: Promise<T>): Promise<T> {
    managed.pending.add(pending);
    this.pending.add(pending);
    void pending.then(
      () => {
        managed.pending.delete(pending);
        this.pending.delete(pending);
      },
      () => {
        managed.pending.delete(pending);
        this.pending.delete(pending);
      },
    );
    return pending;
  }
  private transition(managed: ManagedFtp, state: FtpConnection['state'], errorCode?: string) {
    managed.metadata = {
      ...managed.metadata,
      state,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : { errorCode: undefined }),
    };
    this.changed();
  }
  private admit() {
    if (!this.accepting)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'FTP connections are closed', 503);
  }
  private require(id: string): ManagedFtp {
    const found = this.connections.get(id);
    if (!found) throw new ApplicationError('NOT_FOUND', 'FTP connection not found', 404);
    return found;
  }
  private prune() {
    const completed = [...this.connections.values()].filter(
      (item) =>
        ['failed', 'closed'].includes(item.metadata.state) &&
        !item.pending.size &&
        !item.leases.size &&
        !item.cleanupFailed,
    );
    for (const item of completed.slice(0, Math.max(0, completed.length - 2000)))
      this.connections.delete(item.metadata.id);
  }
}
