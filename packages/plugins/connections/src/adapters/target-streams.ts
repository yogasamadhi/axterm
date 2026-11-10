import { z } from 'zod';
import { hostProxySchema } from '@axterm/plugin-api/catalog';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Duplex } from 'node:stream';
import type { ConnectionStreamInput, ConnectionStreamLease } from '@axterm/plugin-api/host';
import type { ConnectionService } from '../application/connection-service.ts';
import type { ProxyService } from '../application/proxy-service.ts';
import { waitStreamClosed } from './stream-lifetime.ts';

/** Wrap the transport in a plain Node Duplex and join the transport's actual close event. */
class OwnedStream extends Duplex {
  private ended = false;
  constructor(private readonly native: Duplex) {
    super({ allowHalfOpen: true, highWaterMark: 65536 });
    native.pause();
    native.on('data', this.data);
    native.once('end', this.endRead);
    native.on('error', this.failed);
    native.once('close', this.nativeClosed);
  }
  private readonly data = (data: Buffer) => {
    if (!this.push(data)) this.native.pause();
  };
  private readonly endRead = () => this.push(null);
  private readonly failed = () => this.destroy(new Error('CONNECTION_STREAM_FAILED'));
  private readonly nativeClosed = () => {
    this.ended = true;
    this.destroy();
  };
  override _read(): void {
    this.native.resume();
  }
  override _write(
    data: Buffer,
    encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    this.native.write(data, encoding, done);
  }
  override _final(done: () => void): void {
    this.native.end(done);
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    const closed = this.ended ? Promise.resolve() : waitStreamClosed(this.native);
    this.native.destroy();
    void closed.then(
      () => {
        this.native.off('data', this.data);
        this.native.off('end', this.endRead);
        this.native.off('error', this.failed);
        this.native.off('close', this.nativeClosed);
        done(error);
      },
      () => done(new Error('CONNECTION_STREAM_CLOSE_FAILED')),
    );
  }
}

/** Selected application stream leases; vendor handles and owned jump connections stay here. */
export class TargetStreams {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leases = new Set<ConnectionStreamLease>();
  private closing?: Promise<void>;
  constructor(
    private readonly connections: Pick<ConnectionService, 'create' | 'get' | 'handle' | 'close'>,
    private readonly proxies: Pick<ProxyService, 'connectForRoute'>,
  ) {}
  resourceCount(): number {
    return this.pending.size + this.leases.size;
  }
  open(input: ConnectionStreamInput, signal: AbortSignal): Promise<ConnectionStreamLease> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('CONNECTION_STREAMS_CLOSED'));
    if (this.resourceCount() >= 64) return Promise.reject(new Error('CONNECTION_STREAM_CAPACITY'));
    const parsed = z
      .object({
        target: z
          .object({
            host: z
              .string()
              .min(1)
              .max(253)
              .regex(/^[^\0\r\n]+$/),
            port: z.number().int().min(1).max(65535),
          })
          .strict(),
        proxy: hostProxySchema,
        username: z.string().max(128),
        jumpHostId: z.uuid().nullable(),
        timeoutMs: z.number().int().min(1000).max(120000),
      })
      .strict()
      .parse(input);
    const task = Promise.resolve().then(() => this.create(parsed, signal));
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async create(
    input: ConnectionStreamInput,
    signal: AbortSignal,
  ): Promise<ConnectionStreamLease> {
    const abort = new AbortController();
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, abort.signal]);
    const timeout = setTimeout(
      () => abort.abort(new Error('CONNECTION_STREAM_TIMEOUT')),
      input.timeoutMs,
    );
    timeout.unref();
    let stream: Duplex | undefined;
    let jump: string | undefined;
    let stop: Promise<void> | undefined;
    let closed: Promise<void> | undefined;
    let unlisten: (() => void) | undefined;
    const closeJump = () => (jump ? (stop ??= this.connections.close(jump)) : Promise.resolve());
    const cancelled = () => {
      stream?.destroy();
      void closeJump().catch(() => {});
    };
    lifetime.addEventListener('abort', cancelled, { once: true });
    const lease: ConnectionStreamLease = {
      get stream() {
        if (!stream) throw new Error('CONNECTION_STREAM_NOT_OPEN');
        return stream;
      },
      close: () =>
        (closed ??= (async () => {
          abort.abort();
          try {
            if (stream) {
              const done = waitStreamClosed(stream);
              stream.destroy();
              await done;
            }
            await closeJump();
            this.leases.delete(lease);
          } finally {
            lifetime.removeEventListener('abort', cancelled);
            unlisten?.();
          }
        })()),
    };
    try {
      lifetime.throwIfAborted();
      if (input.jumpHostId) {
        jump = this.connections.create({ hostId: input.jumpHostId }).id;
        while (true) {
          lifetime.throwIfAborted();
          const state = this.connections.get(jump);
          if (state.state === 'ready') break;
          if (state.state === 'closed' || state.state === 'failed')
            throw new Error('CONNECTION_STREAM_JUMP_FAILED');
          await delay(25, undefined, { signal: lifetime });
        }
        const handle = this.connections.handle(jump);
        unlisten = handle.onClose(() => abort.abort(new Error('CONNECTION_STREAM_JUMP_CLOSED')));
        stream = (await handle.forwardOut({ host: '127.0.0.1', port: 0 }, input.target)) as Duplex;
      } else {
        stream = await this.proxies.connectForRoute(
          input.proxy,
          input.username,
          input.target,
          input.timeoutMs,
          lifetime,
        );
        if (!stream)
          stream = await new Promise<Duplex>((resolve, reject) => {
            const socket = connect({ ...input.target, signal: lifetime });
            socket.once('error', reject);
            socket.once('connect', () => {
              socket.off('error', reject);
              resolve(socket);
            });
          });
      }
      stream = new OwnedStream(stream);
      this.leases.add(lease);
      stream.on('error', () => {});
      lifetime.throwIfAborted();
      stream.once('close', () => {
        void lease.close().catch(() => {});
      });
      return lease;
    } catch (error) {
      this.leases.add(lease);
      await lease.close();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      await Promise.all([...this.leases].map((lease) => lease.close()));
    })());
  }
}
