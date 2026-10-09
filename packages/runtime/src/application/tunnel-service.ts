import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Tunnel, TunnelProfile } from '@workspace/contracts';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { ConnectionService } from './connection-service';
import type { RealtimeHub } from './realtime-hub';
import { ApplicationError } from './errors';

interface ManagedTunnel {
  metadata: Tunnel;
  server: Server | undefined;
  remote: { host: string; port: number } | undefined;
  sockets: Set<Socket | NodeJS.ReadWriteStream>;
  unsubscribeConnection: (() => void) | undefined;
}

export class TunnelService {
  private readonly tunnels = new Map<string, ManagedTunnel>();
  constructor(
    private readonly connections: ConnectionService,
    private readonly repository: ProductRepository,
    private readonly realtime: RealtimeHub,
  ) {}

  list(): Tunnel[] {
    return [...this.tunnels.values()].map(({ metadata }) => ({ ...metadata }));
  }

  async start(
    input: {
      connectionId: string;
      profileId?: string | undefined;
      profile?: Omit<TunnelProfile, 'id' | 'createdAt' | 'updatedAt' | 'version'> | undefined;
    },
    idempotencyKey: string | undefined,
  ): Promise<Tunnel> {
    if (!idempotencyKey)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const previous = this.repository.resolveIdempotency<Tunnel>(idempotencyKey, 'tunnel', input);
    if (previous) return previous;
    const profile =
      input.profile ??
      (input.profileId
        ? this.repository.getJson<TunnelProfile>('tunnel_profiles', input.profileId)
        : undefined);
    if (!profile) throw new ApplicationError('NOT_FOUND', 'Tunnel profile not found', 404);
    if (
      profile.type !== 'remote' &&
      !profile.allowNonLoopback &&
      !['127.0.0.1', 'localhost', '::1'].includes(profile.bindHost)
    )
      throw new ApplicationError('INVALID_STATE', 'Non-loopback binding was not approved', 409);
    const metadata: Tunnel = {
      id: randomUUID(),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      connectionId: input.connectionId,
      type: profile.type,
      state: 'starting',
      bindHost: profile.bindHost,
      bindPort: profile.bindPort,
      createdAt: new Date().toISOString(),
    };
    const managed: ManagedTunnel = {
      metadata,
      server: undefined,
      remote: undefined,
      sockets: new Set(),
      unsubscribeConnection: undefined,
    };
    this.tunnels.set(metadata.id, managed);
    this.publish(managed);
    try {
      managed.unsubscribeConnection = this.connections
        .handle(input.connectionId)
        .onClose(() => void this.failForConnectionClose(managed));
      if (profile.type === 'local') await this.startLocal(managed, profile);
      else if (profile.type === 'dynamic') await this.startDynamic(managed, profile);
      else await this.startRemote(managed, profile);
      managed.metadata = { ...managed.metadata, state: 'active' };
      this.repository.recordIdempotency(idempotencyKey, 'tunnel', input, managed.metadata);
      this.publish(managed);
      return { ...managed.metadata };
    } catch (error) {
      const failure = classifyTunnelStartError(error);
      managed.metadata = { ...managed.metadata, state: 'failed', errorCode: failure.errorCode };
      this.publish(managed);
      managed.unsubscribeConnection?.();
      managed.unsubscribeConnection = undefined;
      await this.releaseResources(managed);
      this.repository.recordIdempotency(idempotencyKey, 'tunnel', input, managed.metadata);
      throw failure.error;
    }
  }

  private async startLocal(
    managed: ManagedTunnel,
    profile: Omit<TunnelProfile, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
  ) {
    if (!profile.targetHost || !profile.targetPort)
      throw new ApplicationError('INVALID_STATE', 'Tunnel target is required', 409);
    const server = createServer((socket) => {
      managed.sockets.add(socket);
      void this.connections
        .handle(managed.metadata.connectionId)
        .forwardOut(
          { host: socket.remoteAddress ?? '127.0.0.1', port: socket.remotePort ?? 0 },
          { host: profile.targetHost!, port: profile.targetPort! },
        )
        .then(
          (channel) => {
            managed.sockets.add(channel);
            socket.pipe(channel).pipe(socket);
            const cleanup = () => {
              managed.sockets.delete(socket);
              managed.sockets.delete(channel);
            };
            socket.once('close', cleanup);
            channel.once('close', cleanup);
          },
          () => socket.destroy(),
        );
    });
    managed.server = server;
    await listen(server, profile.bindPort, profile.bindHost);
    const address = server.address();
    if (address && typeof address !== 'string')
      managed.metadata = { ...managed.metadata, bindPort: address.port };
  }

  private async startDynamic(
    managed: ManagedTunnel,
    profile: Omit<TunnelProfile, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
  ) {
    const server = createServer((socket) => {
      managed.sockets.add(socket);
      handleSocks5(socket, async (host, port) => {
        const channel = await this.connections
          .handle(managed.metadata.connectionId)
          .forwardOut(
            { host: socket.remoteAddress ?? '127.0.0.1', port: socket.remotePort ?? 0 },
            { host, port },
          );
        managed.sockets.add(channel);
        return channel;
      }).catch(() => socket.destroy());
      socket.once('close', () => managed.sockets.delete(socket));
    });
    managed.server = server;
    await listen(server, profile.bindPort, profile.bindHost);
    const address = server.address();
    if (address && typeof address !== 'string')
      managed.metadata = { ...managed.metadata, bindPort: address.port };
  }

  private async startRemote(
    managed: ManagedTunnel,
    profile: Omit<TunnelProfile, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
  ) {
    if (!profile.targetHost || !profile.targetPort)
      throw new ApplicationError('INVALID_STATE', 'Tunnel target is required', 409);
    const handle = this.connections.handle(managed.metadata.connectionId);
    const port = await handle.forwardIn(profile.bindHost, profile.bindPort, (_info, channel) => {
      const socket = createConnection({ host: profile.targetHost!, port: profile.targetPort! });
      managed.sockets.add(socket);
      managed.sockets.add(channel);
      socket.pipe(channel).pipe(socket);
      const cleanup = () => {
        managed.sockets.delete(socket);
        managed.sockets.delete(channel);
      };
      socket.once('close', cleanup);
      channel.once('close', cleanup);
    });
    managed.remote = { host: profile.bindHost, port };
    managed.metadata = { ...managed.metadata, bindPort: port };
  }

  async close(id: string): Promise<void> {
    const managed = this.tunnels.get(id);
    if (!managed) return;
    managed.metadata = { ...managed.metadata, state: 'stopping' };
    this.publish(managed);
    managed.unsubscribeConnection?.();
    managed.unsubscribeConnection = undefined;
    await this.releaseResources(managed);
    managed.metadata = { ...managed.metadata, state: 'closed' };
    this.publish(managed);
    this.tunnels.delete(id);
  }
  private async failForConnectionClose(managed: ManagedTunnel): Promise<void> {
    if (!this.tunnels.has(managed.metadata.id) || managed.metadata.state === 'failed') return;
    managed.unsubscribeConnection?.();
    managed.unsubscribeConnection = undefined;
    managed.metadata = {
      ...managed.metadata,
      state: 'failed',
      errorCode: 'SSH_CONNECTION_CLOSED',
    };
    this.publish(managed);
    await this.releaseResources(managed);
  }
  private async releaseResources(managed: ManagedTunnel): Promise<void> {
    for (const socket of managed.sockets) if ('destroy' in socket) socket.destroy();
    managed.sockets.clear();
    if (managed.server) await closeServer(managed.server);
    managed.server = undefined;
    if (managed.remote)
      try {
        await this.connections
          .handle(managed.metadata.connectionId)
          .unforwardIn(managed.remote.host, managed.remote.port);
      } catch {
        // The owning SSH transport may already be closed.
      }
    managed.remote = undefined;
  }
  async closeAll() {
    await Promise.all([...this.tunnels.keys()].map((id) => this.close(id)));
  }
  resourceCount() {
    return this.tunnels.size;
  }
  private publish(managed: ManagedTunnel) {
    this.realtime.publish('tunnel.status', managed.metadata);
  }
}

function classifyTunnelStartError(error: unknown): {
  errorCode: string;
  error: ApplicationError;
} {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  )
    return {
      errorCode: 'TUNNEL_PORT_IN_USE',
      error: new ApplicationError('CONFLICT', 'Tunnel bind address is already in use', 409),
    };
  if (error instanceof ApplicationError) return { errorCode: error.code, error };
  return {
    errorCode: 'TUNNEL_START_FAILED',
    error: new ApplicationError('INVALID_STATE', 'Tunnel could not start', 409),
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

async function handleSocks5(
  socket: Socket,
  open: (host: string, port: number) => Promise<NodeJS.ReadWriteStream>,
) {
  let buffer = Buffer.alloc(0);
  let stage: 'greeting' | 'request' = 'greeting';
  const onData = (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    if (stage === 'greeting') {
      if (buffer.length < 2) return;
      const length = 2 + (buffer[1] ?? 0);
      if (buffer.length < length) return;
      if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) return socket.destroy();
      buffer = buffer.subarray(length);
      socket.write(Buffer.from([5, 0]));
      stage = 'request';
    }
    if (stage === 'request') void processRequest();
  };
  const processRequest = async () => {
    if (buffer.length < 5) return;
    if (buffer[0] !== 5 || buffer[1] !== 1) return socket.destroy();
    const type = buffer[3];
    let host: string;
    let offset: number;
    if (type === 1) {
      if (buffer.length < 10) return;
      host = [...buffer.subarray(4, 8)].join('.');
      offset = 8;
    } else if (type === 3) {
      const length = buffer[4] ?? 0;
      if (buffer.length < 7 + length) return;
      host = buffer.subarray(5, 5 + length).toString('utf8');
      offset = 5 + length;
    } else return socket.destroy();
    const port = buffer.readUInt16BE(offset);
    const consumed = offset + 2;
    const remaining = buffer.subarray(consumed);
    socket.off('data', onData);
    socket.pause();
    try {
      const channel = await open(host, port);
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (remaining.length) channel.write(remaining);
      socket.pipe(channel).pipe(socket);
      socket.resume();
    } catch {
      socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
  };
  socket.on('data', onData);
}
