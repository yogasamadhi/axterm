import { randomUUID } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  CreateSpiceSessionInput,
  SpiceCredentialBootstrap,
  SpiceSession,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { SpiceRelay, SpiceRelayHandle, SpiceRelaySocket } from '../ports/spice-relay';
import type { BookmarkTreeService } from './bookmark-tree-service';
import type { ConnectionProfileService } from './connection-profile-service';
import type { ConnectionService } from './connection-service';
import { ApplicationError } from './errors';
import type { ProxyService } from './proxy-service';

interface ManagedSpiceSession {
  metadata: SpiceSession;
  target: { host: string; port: number };
  password: string;
  proxy: NonNullable<ReturnType<BookmarkTreeService['getBookmark']>['spice']>['proxy'];
  jumpHostId: string | null;
  timeoutMs: number;
  credentialClaimed: boolean;
  abort: AbortController;
  relays: Map<string, SpiceRelayHandle>;
  ownedSshConnectionId: string | undefined;
  jumpReady: Promise<void> | undefined;
  expires: ReturnType<typeof setTimeout>;
}

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const CREDENTIAL_CLAIM_MS = 2 * 60 * 1_000;
const MAX_CHANNELS = 16;

export class SpiceSessionService {
  private readonly sessions = new Map<string, ManagedSpiceSession>();

  constructor(
    private readonly bookmarks: BookmarkTreeService,
    private readonly profiles: ConnectionProfileService,
    private readonly host: HostCapabilityClient | undefined,
    private readonly relay: SpiceRelay,
    private readonly proxies?: ProxyService,
    private readonly connections?: ConnectionService,
  ) {}

  async create(input: CreateSpiceSessionInput): Promise<SpiceSession> {
    const bookmark = this.bookmarks.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== 'spice' || !bookmark.spice)
      throw new ApplicationError('VALIDATION_ERROR', 'Bookmark is not a SPICE destination', 400);
    if (this.sessions.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active SPICE session limit has been reached',
        503,
      );
    const profile = bookmark.connectionProfileId
      ? this.profiles.get(bookmark.connectionProfileId).spice
      : undefined;
    const credentialRef = profile?.passwordCredentialRef ?? bookmark.spice.credentialRef;
    const password =
      input.temporaryPassword ??
      (credentialRef ? await this.requireHost().resolveCredential(credentialRef) : '');
    const now = new Date().toISOString();
    const metadata: SpiceSession = {
      id: randomUUID(),
      bookmarkId: bookmark.id,
      title: bookmark.title,
      state: 'created',
      viewOnly: bookmark.spice.viewOnly,
      scaleViewport: bookmark.spice.scaleViewport,
      activeChannels: 0,
      createdAt: now,
      updatedAt: now,
    };
    const expires = setTimeout(() => void this.close(metadata.id), SESSION_LIFETIME_MS);
    expires.unref();
    this.sessions.set(metadata.id, {
      metadata,
      target: { host: bookmark.spice.hostname, port: bookmark.spice.port },
      password,
      proxy: bookmark.spice.proxy,
      jumpHostId: bookmark.spice.jumpHostId,
      timeoutMs: bookmark.spice.connectionTimeoutMs,
      credentialClaimed: false,
      abort: new AbortController(),
      relays: new Map(),
      ownedSshConnectionId: undefined,
      jumpReady: undefined,
      expires,
    });
    return { ...metadata };
  }

  list(): SpiceSession[] {
    return [...this.sessions.values()].map(({ metadata }) => ({ ...metadata }));
  }

  get(id: string): SpiceSession {
    return { ...this.require(id).metadata };
  }

  claimCredentials(id: string): SpiceCredentialBootstrap {
    const managed = this.require(id);
    if (managed.credentialClaimed)
      throw new ApplicationError('CONFLICT', 'SPICE credentials were already claimed', 409);
    if (Date.now() - Date.parse(managed.metadata.createdAt) > CREDENTIAL_CLAIM_MS)
      throw new ApplicationError('INVALID_STATE', 'SPICE credential claim expired', 409);
    managed.credentialClaimed = true;
    const result = { password: managed.password };
    managed.password = '';
    return result;
  }

  async attach(id: string, socket: SpiceRelaySocket): Promise<void> {
    const managed = this.require(id);
    if (!managed.credentialClaimed)
      throw new ApplicationError('INVALID_STATE', 'SPICE credentials must be claimed first', 409);
    if (managed.relays.size >= MAX_CHANNELS)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'SPICE channel limit reached', 503);
    const channelId = randomUUID();
    this.transition(managed, managed.relays.size ? 'ready' : 'connecting');
    const handle = await this.relay.attach({
      socket,
      signal: managed.abort.signal,
      openTarget: (signal) => this.openTarget(managed, signal),
      onReady: () => {
        if (!this.sessions.has(id)) return;
        this.transition(managed, 'ready');
      },
      onClose: (errorCode) => {
        if (!this.sessions.has(id)) return;
        managed.relays.delete(channelId);
        if (!managed.relays.size)
          this.transition(managed, errorCode ? 'failed' : 'closed', errorCode);
        else this.transition(managed, 'ready', errorCode);
      },
    });
    if (!this.sessions.has(id)) handle.close();
    else {
      managed.relays.set(channelId, handle);
      this.transition(managed, 'ready');
    }
  }

  async close(id: string): Promise<void> {
    const managed = this.sessions.get(id);
    if (!managed) return;
    this.sessions.delete(id);
    this.transition(managed, 'closed');
    clearTimeout(managed.expires);
    managed.abort.abort();
    managed.password = '';
    for (const relay of managed.relays.values()) relay.close();
    managed.relays.clear();
    if (managed.ownedSshConnectionId && this.connections)
      await this.connections.close(managed.ownedSshConnectionId).catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  resourceCount(): number {
    return this.sessions.size;
  }

  private async openTarget(managed: ManagedSpiceSession, signal: AbortSignal): Promise<Duplex> {
    if (managed.jumpHostId) {
      if (!this.connections)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'SPICE SSH hopping is unavailable',
          503,
        );
      managed.jumpReady ??= (async () => {
        const connection = this.connections!.create({ hostId: managed.jumpHostId! });
        managed.ownedSshConnectionId = connection.id;
        await waitForSsh(this.connections!, connection.id, managed.timeoutMs, managed.abort.signal);
      })();
      await managed.jumpReady;
      return (await this.connections
        .handle(managed.ownedSshConnectionId!)
        .forwardOut({ host: '127.0.0.1', port: 0 }, managed.target)) as Duplex;
    }
    const proxied = await this.proxies?.connectForRoute(
      managed.proxy,
      '',
      managed.target,
      managed.timeoutMs,
      signal,
    );
    return proxied ?? openTcp(managed.target, managed.timeoutMs, signal);
  }

  private transition(
    managed: ManagedSpiceSession,
    state: SpiceSession['state'],
    errorCode?: string,
  ) {
    managed.metadata = {
      ...managed.metadata,
      state,
      activeChannels: managed.relays.size,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : { errorCode: undefined }),
    };
  }

  private require(id: string) {
    const managed = this.sessions.get(id);
    if (!managed) throw new ApplicationError('NOT_FOUND', 'SPICE session not found', 404);
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
      throw new Error(connection.errorCode ?? 'SPICE jump host failed');
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
  throw new Error('SPICE jump host timed out');
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
    const failed = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timedOut = () => failed(new Error('SPICE connection timed out'));
    const aborted = () => failed(new Error('SPICE connection canceled'));
    socket.once('connect', connected);
    socket.once('error', failed);
    socket.once('timeout', timedOut);
    socket.setTimeout(timeoutMs);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
