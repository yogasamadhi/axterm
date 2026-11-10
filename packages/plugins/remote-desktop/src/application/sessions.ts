import { randomUUID } from 'node:crypto';
import { RemoteError } from '@axterm/plugin-api';
import {
  createRemoteDesktopSessionSchema,
  remoteDesktopSessionSchema,
  resizeRdpSessionSchema,
  type RemoteDesktopSession,
  type CreateRemoteDesktopSession,
  type RemoteDesktopProtocol,
  type RemoteDesktopCredentials,
} from '@axterm/plugin-api/remote-desktop';
import type { ConnectionStreamInput, ConnectionStreamLease } from '@axterm/plugin-api/host';
import type { SessionServices } from '../ports/services.ts';
import type { Relay, RelayHandle, RelaySocket } from '../ports/relay.ts';
export type SessionChange =
  { type: 'upsert'; session: RemoteDesktopSession } | { type: 'remove'; id: string };
interface Managed {
  metadata: RemoteDesktopSession;
  target: ConnectionStreamInput;
  credentials: RemoteDesktopCredentials;
  credentialRef: string | null;
  hasTemporaryPassword: boolean;
  claimed: boolean;
  claimComplete: boolean;
  claimTask?: Promise<void>;
  created: number;
  lifetime: AbortController;
  channels: Map<
    string,
    {
      handle?: RelayHandle;
      pending?: Promise<void>;
      leases: Set<ConnectionStreamLease>;
      closing?: Promise<void>;
    }
  >;
  expires: ReturnType<typeof setTimeout>;
  claimExpires: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}
export function failure(
  reason:
    | 'closed'
    | 'invalid-input'
    | 'not-found'
    | 'capacity'
    | 'conflict'
    | 'receipt-expired'
    | 'unavailable',
): RemoteError<'remoteDesktop/failure'> {
  return new RemoteError('remoteDesktop/failure', 'The remote desktop operation failed', {
    reason,
  });
}
/** Owns metadata, one-time claims and all channel lifetimes; protocol bytes bypass this state. */
export class RemoteDesktopSessions {
  private readonly sessions = new Map<string, Managed>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(change: SessionChange) => void>();
  private closing?: Promise<void>;
  constructor(
    private readonly services: SessionServices,
    private readonly relays: Record<RemoteDesktopProtocol, Relay>,
    private readonly now: () => number = Date.now,
  ) {}
  subscribe(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  list(): RemoteDesktopSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.metadata }));
  }
  get(id: string): RemoteDesktopSession {
    return { ...this.require(id).metadata };
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    const active = [...this.sessions.values()].filter(
      (item) =>
        item.closing || item.channels.size || !['failed', 'closed'].includes(item.metadata.state),
    );
    return Object.freeze({
      rdpSessions: active.filter((item) => item.metadata.protocol === 'rdp').length,
      vncSessions: active.filter((item) => item.metadata.protocol === 'vnc').length,
      spiceSessions: active.filter((item) => item.metadata.protocol === 'spice').length,
      remoteDesktopRequests: this.pending.size,
    });
  }
  resourceCount(): number {
    return (
      this.pending.size +
      [...this.sessions.values()].filter(
        (s) => s.closing || s.channels.size || !['failed', 'closed'].includes(s.metadata.state),
      ).length
    );
  }
  create(
    input: CreateRemoteDesktopSession,
    signal: AbortSignal,
    allocated?: (id: string) => void,
  ): Promise<RemoteDesktopSession> {
    this.assert();
    const parsed = createRemoteDesktopSessionSchema.parse(input);
    if (
      this.sessions.size + this.pending.size >= 24 ||
      [...this.sessions.values()].filter((s) => s.metadata.protocol === parsed.protocol).length +
        this.pending.size >=
        8
    )
      return Promise.reject(failure('capacity'));
    const task = Promise.resolve().then(() =>
      this.createOwned(parsed, AbortSignal.any([signal, this.lifetime.signal]), allocated),
    );
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async createOwned(
    input: CreateRemoteDesktopSession,
    signal: AbortSignal,
    allocated?: (id: string) => void,
  ): Promise<RemoteDesktopSession> {
    signal.throwIfAborted();
    const bookmark = this.services.catalog.getBookmark(input.bookmarkId);
    if (bookmark.protocol !== input.protocol) throw failure('invalid-input');
    const settings = bookmark[input.protocol];
    if (!settings) throw failure('invalid-input');
    const profile = bookmark.connectionProfileId
      ? this.services.catalog.getConnectionProfile(bookmark.connectionProfileId)[input.protocol]
      : undefined;
    const username =
      (profile && 'username' in profile ? profile.username : undefined) ??
      ('username' in settings ? settings.username : '');
    const ref = profile?.passwordCredentialRef ?? settings.credentialRef;
    const password = input.temporaryPassword ?? '';
    signal.throwIfAborted();
    this.assert();
    const now = new Date(this.now()).toISOString();
    const metadata = remoteDesktopSessionSchema.parse({
      id: randomUUID(),
      bookmarkId: bookmark.id,
      title: bookmark.title,
      protocol: input.protocol,
      state: 'created',
      createdAt: now,
      updatedAt: now,
      ...(input.protocol === 'rdp' && bookmark.rdp
        ? {
            width: input.width ?? bookmark.rdp.desktopWidth,
            height: input.height ?? bookmark.rdp.desktopHeight,
            scaleViewport: bookmark.rdp.scaleViewport,
            clipboard: bookmark.rdp.clipboard,
          }
        : {}),
      ...(input.protocol === 'vnc' && bookmark.vnc
        ? {
            viewOnly: bookmark.vnc.viewOnly,
            clipViewport: bookmark.vnc.clipViewport,
            scaleViewport: bookmark.vnc.scaleViewport,
            qualityLevel: bookmark.vnc.qualityLevel,
            compressionLevel: bookmark.vnc.compressionLevel,
            shared: bookmark.vnc.shared,
            showDotCursor: bookmark.vnc.showDotCursor,
            clipboard: bookmark.vnc.clipboard,
          }
        : {}),
      ...(input.protocol === 'spice' && bookmark.spice
        ? {
            viewOnly: bookmark.spice.viewOnly,
            scaleViewport: bookmark.spice.scaleViewport,
            activeChannels: 0,
          }
        : {}),
    });
    const expires = setTimeout(
      () => {
        void this.closeSession(metadata.id).catch(() => {});
      },
      8 * 60 * 60 * 1000,
    );
    expires.unref();
    const claimExpires = setTimeout(() => {
      const current = this.sessions.get(metadata.id);
      if (current) current.credentials.password = '';
    }, 120000);
    claimExpires.unref();
    this.sessions.set(metadata.id, {
      metadata,
      credentialRef: ref,
      hasTemporaryPassword: input.temporaryPassword !== undefined,
      claimExpires,
      created: this.now(),
      claimed: false,
      claimComplete: false,
      credentials: {
        username,
        password,
        domain: input.protocol === 'rdp' ? bookmark.rdp!.domain : '',
        destination: `${settings.hostname.includes(':') ? '[' + settings.hostname + ']' : settings.hostname}:${settings.port}`,
      },
      target: {
        target: { host: settings.hostname, port: settings.port },
        username,
        proxy: settings.proxy,
        jumpHostId: settings.jumpHostId,
        timeoutMs: settings.connectionTimeoutMs,
      },
      lifetime: new AbortController(),
      channels: new Map(),
      expires,
    });
    try {
      allocated?.(metadata.id);
    } catch (error) {
      clearTimeout(expires);
      clearTimeout(claimExpires);
      const managed = this.sessions.get(metadata.id);
      if (managed) managed.credentials.password = '';
      this.sessions.delete(metadata.id);
      throw error;
    }
    this.publish({ type: 'upsert', session: metadata });
    return { ...metadata };
  }
  canClaim(id: string): void {
    this.assert();
    const managed = this.require(id);
    if (managed.closing || managed.claimed || this.now() - managed.created >= 120000) {
      managed.credentials.password = '';
      throw failure('conflict');
    }
  }
  claim(id: string, signal?: AbortSignal): Promise<RemoteDesktopCredentials> {
    this.canClaim(id);
    const managed = this.require(id);
    const lifetime = AbortSignal.any([
      this.lifetime.signal,
      managed.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    lifetime.throwIfAborted();
    managed.claimed = true;
    clearTimeout(managed.claimExpires);
    const temporary = managed.credentials.password;
    managed.credentials.password = '';
    const task = Promise.resolve().then(async () => {
      lifetime.throwIfAborted();
      const password = managed.hasTemporaryPassword
        ? temporary
        : managed.credentialRef
          ? await this.services.credential(managed.credentialRef, lifetime)
          : '';
      lifetime.throwIfAborted();
      if (password.length > 16384) throw failure('invalid-input');
      managed.claimComplete = true;
      return { ...managed.credentials, password };
    });
    managed.claimTask = task.then(
      () => {},
      () => {},
    );
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  resize(id: string, width: number, height: number): RemoteDesktopSession {
    this.assert();
    const managed = this.require(id);
    if (managed.metadata.protocol !== 'rdp' || managed.closing) throw failure('conflict');
    const size = resizeRdpSessionSchema.parse({ width, height });
    managed.metadata = {
      ...managed.metadata,
      ...size,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.publish({ type: 'upsert', session: managed.metadata });
    return { ...managed.metadata };
  }
  canAttach(id: string): void {
    this.assert();
    const m = this.require(id);
    if (!m.claimComplete || m.closing || m.lifetime.signal.aborted) throw failure('conflict');
    if (m.channels.size >= (m.metadata.protocol === 'spice' ? 16 : 1)) throw failure('capacity');
  }
  attach(id: string, socket: RelaySocket): Promise<void> {
    this.canAttach(id);
    const m = this.require(id);
    const channelId = randomUUID();
    const owned: Managed['channels'] extends Map<string, infer T> ? T : never = {
      leases: new Set(),
    };
    m.channels.set(channelId, owned);
    this.transition(m, m.metadata.protocol === 'rdp' ? 'attached' : 'connecting');
    const release = (): Promise<void> =>
      (owned.closing ??= (async () => {
        await owned.pending?.catch(() => {});
        await owned.handle?.close();
        await Promise.all([...owned.leases].map((lease) => lease.close()));
        m.channels.delete(channelId);
        if (!m.closing)
          this.transition(
            m,
            m.channels.size ? 'ready' : m.metadata.state === 'failed' ? 'failed' : 'closed',
            m.metadata.errorCode,
          );
      })());
    // Defer relay activation until the ownership record and pending barrier exist.
    owned.pending = Promise.resolve().then(async () => {
      try {
        owned.handle = await this.relays[m.metadata.protocol].attach({
          socket,
          target: m.target.target,
          timeoutMs: m.target.timeoutMs,
          signal: m.lifetime.signal,
          openTarget: async (signal) => {
            const lease = await this.services.openStream(
              m.target,
              AbortSignal.any([signal, m.lifetime.signal, this.lifetime.signal]),
            );
            owned.leases.add(lease);
            if (m.lifetime.signal.aborted || signal.aborted) {
              await lease.close();
              throw failure('closed');
            }
            return lease.stream;
          },
          onReady: () => {
            if (!m.closing && !owned.closing) this.transition(m, 'ready');
          },
          onClose: (errorCode) => {
            if (!m.closing)
              this.transition(
                m,
                errorCode ? 'failed' : m.channels.size > 1 ? 'ready' : 'closed',
                errorCode,
              );
            queueMicrotask(() => {
              void release().catch(() => {});
            });
          },
        });
        if (m.lifetime.signal.aborted) await owned.handle.close();
      } catch (error) {
        queueMicrotask(() => {
          void release().catch(() => {});
        });
        throw error;
      }
    });
    return owned.pending;
  }
  closeSession(id: string): Promise<void> {
    const m = this.sessions.get(id);
    if (!m) return Promise.resolve();
    return (m.closing ??= Promise.resolve().then(async () => {
      clearTimeout(m.expires);
      clearTimeout(m.claimExpires);
      m.credentials.password = '';
      m.lifetime.abort();
      await m.claimTask;
      await Promise.all(
        [...m.channels.values()].map(async (channel) => {
          await channel.pending?.catch(() => {});
          await channel.handle?.close();
          await Promise.all([...channel.leases].map((lease) => lease.close()));
          await channel.closing;
        }),
      );
      m.channels.clear();
      this.sessions.delete(id);
      this.publish({ type: 'remove', id });
    }));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
      this.listeners.clear();
    })());
  }
  private assert(): void {
    if (this.lifetime.signal.aborted) throw failure('closed');
  }
  private require(id: string): Managed {
    const managed = this.sessions.get(id);
    if (!managed) throw failure('not-found');
    return managed;
  }
  private transition(m: Managed, state: RemoteDesktopSession['state'], errorCode?: string): void {
    m.metadata = remoteDesktopSessionSchema.parse({
      ...m.metadata,
      state,
      errorCode,
      updatedAt: new Date(this.now()).toISOString(),
      ...(m.metadata.protocol === 'spice' ? { activeChannels: m.channels.size } : {}),
    });
    this.publish({ type: 'upsert', session: m.metadata });
  }
  private publish(change: SessionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(change));
      } catch {
        console.warn('REMOTE_DESKTOP_OBSERVER_FAILED');
      }
    }
  }
}
