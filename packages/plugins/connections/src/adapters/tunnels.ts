import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TunnelProfile } from '@axterm/plugin-api/connections';
import type { SshConnectionHandle } from '../ports/ssh-transport.ts';
import type { TunnelLease, TunnelTransport } from '../ports/tunnels.ts';
import { waitStreamClosed } from './stream-lifetime.ts';
import { ApplicationError } from '../application/errors.ts';

interface Connections {
  handle(id: string): SshConnectionHandle;
  close(id: string): Promise<void>;
}
interface Budget {
  streams: number;
  forwards: number;
  controlTimeoutMs: number;
}
/** ssh2 defers close until end: discard unread bytes from a retiring paused channel. */
function retireStream(stream: Duplex): void {
  stream.unpipe();
  stream.destroy();
  stream.resume();
}
/** Native forwarding stays within its connection owner; no stream escapes this adapter. */
export class NativeTunnels implements TunnelTransport {
  private readonly leases = new Set<NativeTunnel>();
  private readonly budget: Budget = { streams: 0, forwards: 0, controlTimeoutMs: 30000 };
  private closing: Promise<void> | undefined;
  constructor(
    private readonly connections: Connections,
    controlTimeoutMs = 30000,
  ) {
    if (!Number.isInteger(controlTimeoutMs) || controlTimeoutMs < 1 || controlTimeoutMs > 120000)
      throw new Error('Invalid tunnel control deadline');
    this.budget.controlTimeoutMs = controlTimeoutMs;
  }
  async start(id: string, profile: TunnelProfile, signal: AbortSignal): Promise<TunnelLease> {
    if (this.closing) throw new ApplicationError('INVALID_STATE', 'Tunnel transport is closed');
    if (this.leases.size >= 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Tunnel listener capacity exceeded', 503);
    signal.throwIfAborted();
    const lease = new NativeTunnel(this.connections, id, profile, signal, this.budget, () =>
      this.leases.delete(lease),
    );
    this.leases.add(lease);
    try {
      await lease.activate();
      signal.throwIfAborted();
      return lease;
    } catch (error) {
      try {
        await lease.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Tunnel activation and cleanup failed', {
          cause: cleanup,
        });
      }
      throw error;
    }
  }
  async closeConnection(id: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.leases].filter((lease) => lease.connectionId === id).map((lease) => lease.close()),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new ApplicationError('INVALID_STATE', 'Connection tunnel resources did not drain');
  }
  resourceCount(): number {
    return this.leases.size + this.budget.streams + this.budget.forwards;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.leases].map((lease) => lease.close()));
      if (this.resourceCount() || results.some((result) => result.status === 'rejected'))
        throw new ApplicationError('INVALID_STATE', 'Native tunnel resources did not drain');
    })());
  }
}

class NativeTunnel implements TunnelLease {
  readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private readonly handle: SshConnectionHandle;
  private readonly unsubscribe: () => void;
  private readonly streams = new Map<Duplex, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private server: Server | undefined;
  private remotePort: number | undefined;
  private activation: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private accepting = true;
  private connectionEnded = false;
  private controls = 0;
  private bound: number;
  constructor(
    private readonly connections: Connections,
    private readonly id: string,
    private readonly profile: TunnelProfile,
    source: AbortSignal,
    private readonly budget: Budget,
    private readonly released: () => void,
  ) {
    this.bound = profile.bindPort;
    this.handle = connections.handle(id);
    this.signal = AbortSignal.any([source, this.abort.signal]);
    this.unsubscribe = this.handle.onClose(() => {
      this.connectionEnded = true;
      this.abort.abort();
    });
    this.signal.addEventListener('abort', this.canceled, { once: true });
  }
  get bindPort(): number {
    return this.bound;
  }
  get connectionId(): string {
    return this.id;
  }
  activate(): Promise<void> {
    return (this.activation ??= Promise.resolve().then(() => this.activateOwned()));
  }
  private async activateOwned(): Promise<void> {
    this.signal.throwIfAborted();
    if (this.profile.type === 'remote') {
      this.remotePort = await this.control(() =>
        this.handle.forwardIn(this.profile.bindHost, this.profile.bindPort, (_info, channel) => {
          const remote = channel as Duplex;
          if (!this.own(remote)) return;
          const local = createConnection({
            host: this.profile.targetHost!,
            port: this.profile.targetPort!,
          });
          if (!this.own(local)) {
            retireStream(remote);
            return;
          }
          this.wire(local, remote);
        }),
      );
      if (!Number.isInteger(this.remotePort) || this.remotePort < 1 || this.remotePort > 65535) {
        await this.connections.close(this.id);
        throw new ApplicationError('INVALID_STATE', 'Remote forwarding returned an invalid port');
      }
      this.bound = this.remotePort;
    } else {
      const server = createServer({ allowHalfOpen: true, highWaterMark: 64 * 1024 }, (socket) => {
        if (!this.own(socket)) return;
        socket.setNoDelay(true);
        socket.pause();
        if (this.profile.type === 'dynamic') this.socks(socket);
        else this.forward(socket, this.profile.targetHost!, this.profile.targetPort!);
      });
      server.maxConnections = 64;
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off('error', failed);
          server.off('listening', ready);
          server.off('close', closed);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const closed = () => {
          cleanup();
          reject(new ApplicationError('REQUEST_CANCELED', 'Tunnel listener was canceled'));
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        server.once('error', failed);
        server.once('listening', ready);
        server.once('close', closed);
        try {
          server.listen({
            host: this.profile.bindHost,
            port: this.profile.bindPort,
            signal: this.signal,
          });
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      // Runtime listener failures revoke the complete lease, not just its metadata.
      server.on('error', this.canceled);
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new ApplicationError('INVALID_STATE', 'Tunnel listener has no TCP address');
      this.bound = address.port;
    }
    this.signal.throwIfAborted();
  }
  private readonly canceled = () => {
    if ((this.controls || this.pending.size) && !this.connectionEnded)
      void this.connections.close(this.id).catch(() => {});
    void this.close().catch(() => {});
  };
  private async control<T>(perform: () => Promise<T>): Promise<T> {
    this.controls++;
    const timer = setTimeout(() => {
      if (!this.connectionEnded) void this.connections.close(this.id).catch(() => {});
    }, this.budget.controlTimeoutMs);
    try {
      return await perform();
    } finally {
      clearTimeout(timer);
      this.controls--;
    }
  }
  private own(stream: Duplex): boolean {
    const available =
      this.accepting &&
      !this.signal.aborted &&
      this.streams.size < 128 &&
      this.budget.streams < 1024;
    const failed = () => retireStream(stream);
    stream.on('error', failed);
    this.budget.streams++;
    const done = waitStreamClosed(stream).then(() => {
      stream.off('error', failed);
      this.streams.delete(stream);
      this.budget.streams--;
    });
    this.streams.set(stream, done);
    if (!available) {
      retireStream(stream);
      if (this.streams.size > 128 || this.budget.streams > 1024)
        void this.connections.close(this.id).catch(() => {});
    }
    return available;
  }
  private wire(left: Duplex, right: Duplex): void {
    left.allowHalfOpen = true;
    right.allowHalfOpen = true;
    left.once('close', () => {
      if (!left.readableEnded || left.errored) retireStream(right);
    });
    right.once('close', () => {
      if (!right.readableEnded || right.errored) retireStream(left);
    });
    left.pipe(right).pipe(left);
    left.resume();
  }
  private forward(socket: Socket, host: string, port: number, remaining?: Buffer): void {
    if (this.budget.forwards >= 32 || this.signal.aborted) {
      socket.destroy();
      return;
    }
    socket.pause();
    this.budget.forwards++;
    const task = (async () => {
      const channel = (await this.control(() =>
        this.handle.forwardOut(
          { host: socket.remoteAddress ?? '127.0.0.1', port: socket.remotePort ?? 0 },
          { host, port },
        ),
      )) as Duplex;
      if (!this.own(channel) || socket.destroyed) {
        retireStream(channel);
        return;
      }
      if (remaining) {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (remaining.length) channel.write(remaining);
      }
      this.wire(socket, channel);
    })();
    this.pending.add(task);
    void task.then(
      () => {
        this.pending.delete(task);
        this.budget.forwards--;
      },
      () => {
        this.pending.delete(task);
        this.budget.forwards--;
        socket.destroy();
      },
    );
  }
  private socks(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'request' = 'greeting';
    const cleanup = () => {
      socket.off('data', data);
      socket.off('close', cleanup);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
    }, 5000);
    const data = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 128 * 1024) {
        cleanup();
        socket.destroy();
        return;
      }
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const length = 2 + buffer[1]!;
        if (buffer.length < length) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) {
          cleanup();
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(length);
        stage = 'request';
        socket.write(Buffer.from([5, 0]));
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
        cleanup();
        socket.destroy();
        return;
      }
      let host: string;
      let offset: number;
      if (buffer[3] === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.');
        offset = 8;
      } else if (buffer[3] === 3) {
        const length = buffer[4]!;
        if (!length || buffer.length < 7 + length) return;
        host = buffer.subarray(5, 5 + length).toString();
        offset = 5 + length;
      } else {
        cleanup();
        socket.destroy();
        return;
      }
      const port = buffer.readUInt16BE(offset);
      if (!port || !host || host.includes('\0')) {
        cleanup();
        socket.destroy();
        return;
      }
      const remaining = buffer.subarray(offset + 2);
      cleanup();
      this.forward(socket, host, port, remaining);
    };
    socket.on('data', data);
    socket.once('close', cleanup);
    socket.resume();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const stopped = Promise.withResolvers<void>();
    this.closing = stopped.promise;
    this.accepting = false;
    this.abort.abort();
    void this.drain().then(stopped.resolve, stopped.reject);
    return this.closing;
  }
  private async drain(): Promise<void> {
    await this.activation?.catch(() => {});
    const errors: unknown[] = [];
    if (this.remotePort !== undefined && !this.connectionEnded) {
      try {
        await this.control(() => this.handle.unforwardIn(this.profile.bindHost, this.remotePort!));
      } catch (error) {
        // Revoking the owning SSH connection is the safe fallback when a remote
        // listener cannot be unregistered, including concurrent owner shutdown.
        try {
          await this.connections.close(this.id);
        } catch (closeError) {
          errors.push(closeError);
        }
        if (!this.connectionEnded) errors.push(error);
      }
    }
    for (const stream of this.streams.keys()) retireStream(stream);
    const server = this.server;
    if (server) {
      server.off('error', this.canceled);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.allSettled([...this.pending]);
    while (this.streams.size) await Promise.all([...this.streams.values()]);
    this.unsubscribe();
    this.signal.removeEventListener('abort', this.canceled);
    if (errors.length)
      throw new AggregateError(errors, 'Remote tunnel forwarding did not unregister');
    this.released();
  }
}
