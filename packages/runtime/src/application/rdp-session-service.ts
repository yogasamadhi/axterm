import { randomUUID } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  CreateRdpSessionInput,
  RdpCredentialBootstrap,
  RdpSession,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { RdpRelay, RdpRelayHandle, RdpRelaySocket } from '../ports/rdp-relay';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionProfileService } from './connection-profile-service';
import type { ConnectionService } from './connection-service';
import { ApplicationError } from './errors';
import type { ProxyService } from './proxy-service';

interface ManagedRdpSession {
  metadata: RdpSession;
  target: { host: string; port: number };
  username: string;
  password: string;
  domain: string;
  proxy: NonNullable<ReturnType<BookmarkTreeService['getBookmark']>['rdp']>['proxy'];
  jumpHostId: string | null;
  timeoutMs: number;
  credentialClaimed: boolean;
  abort: AbortController;
  relay: RdpRelayHandle | undefined;
  ownedSshConnectionId: string | undefined;
  expires: ReturnType<typeof setTimeout>;
}

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const CREDENTIAL_CLAIM_MS = 2 * 60 * 1_000;

export class RdpSessionService {
  private readonly sessions = new Map<string, ManagedRdpSession>();

  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly profiles: ConnectionProfileService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly relay: RdpRelay,
    private readonly proxies?: ProxyService,
    private readonly connections?: ConnectionService,
  ) {}

  async create(input: CreateRdpSessionInput): Promise<RdpSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'rdp' || !bookmark.rdp)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not an RDP destination', 400);
    if (this.sessions.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active RDP session limit has been reached',
        503,
      );
    const profile = bookmark.connectionProfileId
      ? this.profiles.get(bookmark.connectionProfileId).rdp
      : undefined;
    const username = profile?.username ?? bookmark.rdp.username;
    const credentialRef = profile?.passwordCredentialRef ?? bookmark.rdp.credentialRef;
    const password =
      input.temporaryPassword ??
      (credentialRef ? await this.requireHost().resolveCredential(credentialRef) : '');
    const now = new Date().toISOString();
    const metadata: RdpSession = {
      id: randomUUID(),
      bookmarkId: bookmark.id,
      title: bookmark.title,
      state: 'created',
      width: input.width ?? bookmark.rdp.desktopWidth,
      height: input.height ?? bookmark.rdp.desktopHeight,
      scaleViewport: bookmark.rdp.scaleViewport,
      clipboard: bookmark.rdp.clipboard,
      createdAt: now,
      updatedAt: now,
    };
    const expires = setTimeout(() => void this.close(metadata.id), SESSION_LIFETIME_MS);
    expires.unref();
    this.sessions.set(metadata.id, {
      metadata,
      target: { host: bookmark.rdp.hostname, port: bookmark.rdp.port },
      username,
      password,
      domain: bookmark.rdp.domain,
      proxy: bookmark.rdp.proxy,
      jumpHostId: bookmark.rdp.jumpHostId,
      timeoutMs: bookmark.rdp.connectionTimeoutMs,
      credentialClaimed: false,
      abort: new AbortController(),
      expires,
      relay: undefined,
      ownedSshConnectionId: undefined,
    });
    return { ...metadata };
  }

  list(): RdpSession[] {
    return [...this.sessions.values()].map(({ metadata }) => ({ ...metadata }));
  }

  get(id: string): RdpSession {
    return { ...this.require(id).metadata };
  }

  claimCredentials(id: string): RdpCredentialBootstrap {
    const managed = this.require(id);
    if (managed.credentialClaimed)
      throw new ApplicationError('CONFLICT', 'RDP credentials were already claimed', 409);
    if (Date.now() - Date.parse(managed.metadata.createdAt) > CREDENTIAL_CLAIM_MS)
      throw new ApplicationError('INVALID_STATE', 'RDP credential claim expired', 409);
    managed.credentialClaimed = true;
    const result = {
      username: managed.username,
      password: managed.password,
      domain: managed.domain,
      destination: formatDestination(managed.target),
    };
    managed.password = '';
    return result;
  }

  async attach(id: string, socket: RdpRelaySocket): Promise<void> {
    const managed = this.require(id);
    if (!managed.credentialClaimed)
      throw new ApplicationError('INVALID_STATE', 'RDP credentials must be claimed first', 409);
    if (managed.relay)
      throw new ApplicationError('CONFLICT', 'RDP session already has a transport', 409);
    this.transition(managed, 'attached');
    managed.relay = await this.relay.attach({
      socket,
      target: managed.target,
      timeoutMs: managed.timeoutMs,
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

  resize(id: string, width: number, height: number): RdpSession {
    const managed = this.require(id);
    managed.metadata = { ...managed.metadata, width, height, updatedAt: new Date().toISOString() };
    return { ...managed.metadata };
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

  private async openTarget(managed: ManagedRdpSession, signal: AbortSignal): Promise<Duplex> {
    if (managed.jumpHostId) {
      if (!this.connections)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'RDP SSH hopping is unavailable', 503);
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
    if (proxied) return proxied;
    return openTcp(managed.target, managed.timeoutMs, signal);
  }

  private async release(managed: ManagedRdpSession, closeRelay: boolean): Promise<void> {
    // Closed/failed metadata remains inspectable until its normal lifetime
    // expires. Explicit owner cleanup removes it immediately.
    if (closeRelay) clearTimeout(managed.expires);
    managed.abort.abort();
    managed.password = '';
    if (closeRelay) managed.relay?.close();
    managed.relay = undefined;
    if (managed.ownedSshConnectionId && this.connections)
      await this.connections.close(managed.ownedSshConnectionId).catch(() => undefined);
    managed.ownedSshConnectionId = undefined;
  }

  private transition(managed: ManagedRdpSession, state: RdpSession['state'], errorCode?: string) {
    managed.metadata = {
      ...managed.metadata,
      state,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : { errorCode: undefined }),
    };
  }

  private require(id: string): ManagedRdpSession {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'RDP session not found', 404);
    return managed;
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
      throw new Error(connection.errorCode ?? 'RDP jump host failed');
    await new Promise<void>((resolve, reject) => {
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        callback();
      };
      const timer = setTimeout(() => finish(resolve), 50);
      const abort = () => {
        finish(() => reject(signal.reason));
      };
      signal.addEventListener('abort', abort, { once: true });
      timer.unref();
    });
  }
  throw new Error('RDP jump host timed out');
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
      reject(new Error('RDP target connection failed'));
    };
    const timedOut = () => {
      cleanup();
      socket.destroy();
      reject(new Error('RDP target connection timed out'));
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

function formatDestination(target: { host: string; port: number }) {
  return `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
}
