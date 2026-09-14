import { randomUUID } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  CreateVncSessionInput,
  VncCredentialBootstrap,
  VncSession,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { VncRelay, VncRelayHandle, VncRelaySocket } from '../ports/vnc-relay';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionProfileService } from './connection-profile-service';
import type { ConnectionService } from './connection-service';
import { ApplicationError } from './errors';
import type { ProxyService } from './proxy-service';

interface ManagedVncSession {
  metadata: VncSession;
  target: { host: string; port: number };
  username: string;
  password: string;
  proxy: NonNullable<ReturnType<BookmarkTreeService['getBookmark']>['vnc']>['proxy'];
  jumpHostId: string | null;
  timeoutMs: number;
  credentialClaimed: boolean;
  abort: AbortController;
  relay: VncRelayHandle | undefined;
  ownedSshConnectionId: string | undefined;
  expires: ReturnType<typeof setTimeout>;
}

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const CREDENTIAL_CLAIM_MS = 2 * 60 * 1_000;

export class VncSessionService {
  private readonly sessions = new Map<string, ManagedVncSession>();

  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly profiles: ConnectionProfileService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly relay: VncRelay,
    private readonly proxies?: ProxyService,
    private readonly connections?: ConnectionService,
  ) {}

  async create(input: CreateVncSessionInput): Promise<VncSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'vnc' || !bookmark.vnc)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not a VNC destination', 400);
    if (this.sessions.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active VNC session limit has been reached',
        503,
      );
    const profile = bookmark.connectionProfileId
      ? this.profiles.get(bookmark.connectionProfileId).vnc
      : undefined;
    const username = profile?.username ?? bookmark.vnc.username;
    const credentialRef = profile?.passwordCredentialRef ?? bookmark.vnc.credentialRef;
    const password =
      input.temporaryPassword ??
      (credentialRef ? await this.requireHost().resolveCredential(credentialRef) : '');
    const now = new Date().toISOString();
    const metadata: VncSession = {
      id: randomUUID(),
      bookmarkId: bookmark.id,
      title: bookmark.title,
      state: 'created',
      viewOnly: bookmark.vnc.viewOnly,
      clipViewport: bookmark.vnc.clipViewport,
      scaleViewport: bookmark.vnc.scaleViewport,
      qualityLevel: bookmark.vnc.qualityLevel,
      compressionLevel: bookmark.vnc.compressionLevel,
      shared: bookmark.vnc.shared,
      showDotCursor: bookmark.vnc.showDotCursor,
      clipboard: bookmark.vnc.clipboard,
      createdAt: now,
      updatedAt: now,
    };
    const expires = setTimeout(() => void this.close(metadata.id), SESSION_LIFETIME_MS);
    expires.unref();
    this.sessions.set(metadata.id, {
      metadata,
      target: { host: bookmark.vnc.hostname, port: bookmark.vnc.port },
      username,
      password,
      proxy: bookmark.vnc.proxy,
      jumpHostId: bookmark.vnc.jumpHostId,
      timeoutMs: bookmark.vnc.connectionTimeoutMs,
      credentialClaimed: false,
      abort: new AbortController(),
      relay: undefined,
      ownedSshConnectionId: undefined,
      expires,
    });
    return { ...metadata };
  }

  list(): VncSession[] {
    return [...this.sessions.values()].map(({ metadata }) => ({ ...metadata }));
  }

  get(id: string): VncSession {
    return { ...this.require(id).metadata };
  }

  claimCredentials(id: string): VncCredentialBootstrap {
    const managed = this.require(id);
    if (managed.credentialClaimed)
      throw new ApplicationError('CONFLICT', 'VNC credentials were already claimed', 409);
    if (Date.now() - Date.parse(managed.metadata.createdAt) > CREDENTIAL_CLAIM_MS)
      throw new ApplicationError('INVALID_STATE', 'VNC credential claim expired', 409);
    managed.credentialClaimed = true;
    const result = { username: managed.username, password: managed.password };
    managed.password = '';
    return result;
  }

  async attach(id: string, socket: VncRelaySocket): Promise<void> {
    const managed = this.require(id);
    if (!managed.credentialClaimed)
      throw new ApplicationError('INVALID_STATE', 'VNC credentials must be claimed first', 409);
    if (managed.relay)
      throw new ApplicationError('CONFLICT', 'VNC session already has a transport', 409);
    this.transition(managed, 'connecting');
    managed.relay = await this.relay.attach({
      socket,
      signal: managed.abort.signal,
      openTarget: (signal) => this.openTarget(managed, signal),
      onReady: () => this.transition(managed, 'ready'),
      onClose: (errorCode) => {
        if (!this.sessions.has(id)) return;
        this.transition(managed, errorCode ? 'failed' : 'closed', errorCode);
        void this.release(managed, false);
      },
    });
  }

  async close(id: string): Promise<void> {
    const managed = this.sessions.get(id);
    if (!managed) return;
    this.sessions.delete(id);
    this.transition(managed, 'closed');
    await this.release(managed, true);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  private async openTarget(managed: ManagedVncSession, signal: AbortSignal): Promise<Duplex> {
    if (managed.jumpHostId) {
      if (!this.connections)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'VNC SSH hopping is unavailable', 503);
      const connection = this.connections.create({ hostId: managed.jumpHostId });
      managed.ownedSshConnectionId = connection.id;
      await waitForSsh(this.connections, connection.id, managed.timeoutMs, signal);
      return (await this.connections
        .handle(connection.id)
        .forwardOut({ host: '127.0.0.1', port: 0 }, managed.target)) as Duplex;
    }
    const proxied = await this.proxies?.connectForRoute(
      managed.proxy,
      managed.username,
      managed.target,
      managed.timeoutMs,
      signal,
    );
    return proxied ?? openTcp(managed.target, managed.timeoutMs, signal);
  }

  private async release(managed: ManagedVncSession, closeRelay: boolean) {
    if (closeRelay) clearTimeout(managed.expires);
    managed.abort.abort();
    managed.password = '';
    if (closeRelay) managed.relay?.close();
    managed.relay = undefined;
    if (managed.ownedSshConnectionId && this.connections)
      await this.connections.close(managed.ownedSshConnectionId).catch(() => undefined);
    managed.ownedSshConnectionId = undefined;
  }

  private transition(managed: ManagedVncSession, state: VncSession['state'], errorCode?: string) {
    managed.metadata = {
      ...managed.metadata,
      state,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : { errorCode: undefined }),
    };
  }

  private require(id: string) {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'VNC session not found', 404);
    return managed;
  }

  private requireHost() {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Local credential storage is unavailable',
        503,
      );
    return this.host;
  }
}

async function waitForSsh(
  connections: ConnectionService,
  id: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    const connection = connections.get(id);
    if (connection.state === 'ready') return;
    if (connection.state === 'failed' || connection.state === 'closed')
      throw new Error(connection.errorCode ?? 'VNC jump host failed');
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        callback();
      };
      const timer = setTimeout(() => finish(resolve), 50);
      const abort = () => finish(() => reject(signal.reason));
      signal.addEventListener('abort', abort, { once: true });
      timer.unref();
    });
  }
  throw new Error('VNC jump host timed out');
}

function openTcp(
  target: { host: string; port: number },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Duplex> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = connectTcp(target);
    const cleanup = () => {
      socket.off('connect', connected);
      socket.off('error', failed);
      socket.off('timeout', timedOut);
      signal.removeEventListener('abort', aborted);
    };
    const connected = () => {
      cleanup();
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      resolve(socket);
    };
    const failed = () => {
      cleanup();
      socket.destroy();
      reject(new Error('VNC target connection failed'));
    };
    const timedOut = () => {
      cleanup();
      socket.destroy();
      reject(new Error('VNC target connection timed out'));
    };
    const aborted = () => {
      cleanup();
      socket.destroy();
      reject(signal.reason);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', connected);
    socket.once('error', failed);
    socket.once('timeout', timedOut);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
