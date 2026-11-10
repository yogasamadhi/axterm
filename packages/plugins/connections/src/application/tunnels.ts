import { randomUUID } from 'node:crypto';
import type {
  Connection,
  Tunnel,
  TunnelProfile,
  StartTunnelInput,
} from '@axterm/plugin-api/connections';
import type {
  TunnelProfiles,
  TunnelTransport,
  TunnelLease,
  TunnelEvents,
} from '../ports/tunnels.ts';
import { ApplicationError } from './errors.ts';
interface Managed {
  metadata: Tunnel;
  abort: AbortController;
  lease?: TunnelLease;
  dispose?: () => void;
  closing?: Promise<void>;
  opening?: Promise<Tunnel>;
}
/** Policy and live facts; the transport owns every listener, socket and SSH channel. */
export class Tunnels {
  private readonly entries = new Map<string, Managed>();
  private readonly pending = new Set<Promise<unknown>>();
  private accepting = true;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly profiles: TunnelProfiles,
    private readonly connection: (id: string) => Connection,
    private readonly transport: TunnelTransport,
    private readonly events: TunnelEvents,
  ) {}
  list(): Tunnel[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.metadata }));
  }
  get(id: string): Tunnel {
    const value = this.entries.get(id);
    if (!value) throw new ApplicationError('NOT_FOUND', 'Tunnel not found', 404);
    return { ...value.metadata };
  }
  start(
    input: StartTunnelInput,
    signal?: AbortSignal,
    allocated?: (id: string) => void,
  ): Promise<Tunnel> {
    if (!this.accepting)
      return Promise.reject(new ApplicationError('INVALID_STATE', 'Tunnels are closed'));
    if (this.entries.size >= 64)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'Tunnel capacity exceeded', 503),
      );
    if (signal?.aborted)
      return Promise.reject(
        new ApplicationError('REQUEST_CANCELED', 'Tunnel activation was canceled'),
      );
    const saved = input.profileId ? this.profiles.get(input.profileId) : undefined;
    const now = new Date().toISOString();
    const profile: TunnelProfile = input.profile
      ? {
          ...input.profile,
          id: saved?.id ?? randomUUID(),
          createdAt: now,
          updatedAt: now,
          version: 1,
        }
      : saved!;
    if (!profile) throw new ApplicationError('VALIDATION_ERROR', 'Tunnel profile is required', 400);
    const connection = this.connection(input.connectionId);
    if (connection.state !== 'ready' || connection.hostId !== profile.hostId)
      throw new ApplicationError('CONFLICT', 'Tunnel profile does not match the ready connection');
    if (
      profile.type !== 'remote' &&
      !profile.allowNonLoopback &&
      !['127.0.0.1', 'localhost', '::1'].includes(profile.bindHost)
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Non-loopback binding requires explicit opt-in',
        400,
      );
    const managed: Managed = {
      metadata: {
        id: randomUUID(),
        connectionId: input.connectionId,
        ...(input.profileId ? { profileId: input.profileId } : {}),
        type: profile.type,
        state: 'starting',
        bindHost: profile.bindHost,
        bindPort: profile.bindPort,
        createdAt: now,
      },
      abort: new AbortController(),
    };
    this.entries.set(managed.metadata.id, managed);
    try {
      allocated?.(managed.metadata.id);
    } catch (error) {
      this.entries.delete(managed.metadata.id);
      throw error;
    }
    this.publish(managed);
    const canceled = () => managed.abort.abort();
    signal?.addEventListener('abort', canceled, { once: true });
    if (signal?.aborted) canceled();
    const task = Promise.resolve().then(() => this.activate(managed, profile));
    managed.opening = task;
    this.pending.add(task);
    const settled = () => {
      this.pending.delete(task);
      signal?.removeEventListener('abort', canceled);
    };
    void task.then(settled, settled);
    return task;
  }
  private async activate(managed: Managed, profile: TunnelProfile): Promise<Tunnel> {
    try {
      const lease = await this.transport.start(
        managed.metadata.connectionId,
        profile,
        managed.abort.signal,
      );
      managed.lease = lease;
      const lost = () => {
        if (!['starting', 'active'].includes(managed.metadata.state)) return;
        managed.metadata = {
          ...managed.metadata,
          state: 'failed',
          errorCode: 'SSH_CONNECTION_LOST',
        };
        this.publish(managed);
      };
      lease.signal.addEventListener('abort', lost, { once: true });
      managed.dispose = () => lease.signal.removeEventListener('abort', lost);
      managed.abort.signal.throwIfAborted();
      if (lease.signal.aborted)
        throw new ApplicationError('SSH_CONNECTION_LOST', 'Tunnel connection closed', 503);
      managed.metadata = { ...managed.metadata, bindPort: lease.bindPort, state: 'active' };
      this.publish(managed);
      return { ...managed.metadata };
    } catch (error) {
      managed.metadata = {
        ...managed.metadata,
        state: 'failed',
        errorCode: managed.abort.signal.aborted
          ? 'REQUEST_CANCELED'
          : error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE'
            ? 'TUNNEL_PORT_IN_USE'
            : error instanceof ApplicationError
              ? error.code
              : 'TUNNEL_START_FAILED',
      };
      this.publish(managed);
      try {
        await managed.lease?.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Tunnel failure cleanup did not drain', {
          cause: cleanup,
        });
      }
      if (managed.abort.signal.aborted)
        throw new ApplicationError('REQUEST_CANCELED', 'Tunnel activation was canceled');
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        managed.metadata.errorCode === 'TUNNEL_PORT_IN_USE' ? 'CONFLICT' : 'INVALID_STATE',
        'Tunnel could not start',
      );
    }
  }
  stop(id: string): Promise<void> {
    const managed = this.entries.get(id);
    if (!managed) return Promise.resolve();
    if (managed.closing) return managed.closing;
    managed.metadata = { ...managed.metadata, state: 'stopping' };
    this.publish(managed);
    managed.dispose?.();
    managed.abort.abort();
    return (managed.closing = (async () => {
      // A pending activation owns its late lease until the transport has drained it.
      await managed.opening?.catch(() => {});
      await managed.lease?.close();
      this.entries.delete(id);
      this.publish({ ...managed, metadata: { ...managed.metadata, state: 'closed' } });
    })());
  }
  async connectionClosed(id: string): Promise<void> {
    await this.transport.closeConnection(id);
    for (const managed of this.entries.values())
      if (managed.metadata.connectionId === id) {
        await managed.opening?.catch(() => {});
        await managed.lease?.close();
      }
  }
  resourceSnapshot(): Readonly<Record<string, number>> {
    return Object.freeze({
      tunnels: this.entries.size,
      nativeTunnelResources: this.transport.resourceCount(),
    });
  }
  resourceCount(): number {
    return this.pending.size + this.transport.resourceCount();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    return (this.closing = (async () => {
      const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
      await this.transport.close();
      if (
        results.some((result) => result.status === 'rejected') ||
        this.pending.size ||
        this.transport.resourceCount()
      )
        throw new ApplicationError('INVALID_STATE', 'Tunnels did not drain');
    })());
  }
  private publish(managed: Managed): void {
    this.events.changed({ ...managed.metadata });
  }
}
