import {
  Readable,
  Writable,
  type Readable as NativeReadable,
  type Writable as NativeWritable,
} from 'node:stream';
import type { RemoteFilesystem, RemoteFileLease } from '@axterm/plugin-api/host';
import { waitStreamClosed as afterClosed } from './stream-lifetime.ts';
import { ApplicationError } from '../application/errors.ts';
const closed = () =>
  new ApplicationError('REQUEST_CANCELED', 'The remote file channel is no longer available', 409);
const capacity = () =>
  new ApplicationError('CAPACITY_EXCEEDED', 'Remote file resource capacity exceeded', 503);
interface StreamPair {
  native: NativeReadable | NativeWritable;
  exposed: Readable | Writable;
  done: Promise<void>;
}
/** Public streams are Node stream facades; the vendor channel never leaves its owner. */
export class OwnedFileLease implements RemoteFileLease {
  private readonly lifetime = new AbortController();
  readonly signal: AbortSignal;
  readonly filesystem: RemoteFilesystem;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly streams = new Set<StreamPair>();
  private open = true;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly native: RemoteFilesystem,
    signal: AbortSignal,
    private readonly released: () => void,
  ) {
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
    this.filesystem = {
      realpath: (path) => this.run(() => native.realpath(path)),
      list: (path) => this.run(() => native.list(path)),
      stat: (path) => this.run(() => native.stat(path)),
      lstat: (path) => this.run(() => native.lstat(path)),
      mkdir: (path) => this.run(() => native.mkdir(path)),
      rename: (from, to) => this.run(() => native.rename(from, to)),
      replace: (from, to) => this.run(() => native.replace(from, to)),
      unlink: (path) => this.run(() => native.unlink(path)),
      rmdir: (path) => this.run(() => native.rmdir(path)),
      chmod: (path, mode) => this.run(() => native.chmod(path, mode)),
      readStream: (path, options) => {
        this.admitStream();
        return this.readable(native.readStream(path, options));
      },
      writeStream: (path, options) => {
        this.admitStream();
        return this.writable(native.writeStream(path, options));
      },
      close: () => this.close(),
    };
    this.signal.addEventListener('abort', this.aborted, { once: true });
    if (this.signal.aborted) this.aborted();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.open = false;
    this.signal.removeEventListener('abort', this.aborted);
    this.lifetime.abort();
    return (this.closing = (async () => {
      const streams = [...this.streams];
      for (const pair of streams) {
        pair.exposed.destroy();
        pair.native.destroy();
      }
      const closing = this.native.close();
      const results = await Promise.allSettled([
        closing,
        ...streams.map((pair) => pair.done),
        ...this.operations,
      ]);
      if (results[0]?.status === 'rejected')
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'The remote file channel did not drain',
          503,
        );
      this.released();
    })());
  }
  resourceCount(): number {
    return this.operations.size + this.streams.size;
  }
  private readonly aborted = () => {
    if (this.open) void this.close().catch(() => {});
  };
  private assert(): void {
    if (!this.open || this.signal.aborted) throw closed();
  }
  private admitStream(): void {
    this.assert();
    if (this.streams.size >= 32) throw capacity();
  }
  private run<T>(perform: () => Promise<T>): Promise<T> {
    try {
      this.assert();
      if (this.operations.size >= 64) throw capacity();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = Promise.resolve()
      .then(() => {
        this.assert();
        return perform();
      })
      .then((value) => {
        this.assert();
        return value;
      });
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  private track(native: NativeReadable | NativeWritable, exposed: Readable | Writable): void {
    // Observe failures immediately, before a consumer can install its pipeline listeners.
    const nativeDone = afterClosed(native);
    const exposedDone = afterClosed(exposed);
    const pair: StreamPair = {
      native,
      exposed,
      done: Promise.all([nativeDone, exposedDone]).then(() => {}),
    };
    this.streams.add(pair);
    void pair.done.finally(() => this.streams.delete(pair));
    exposed.on('error', () => {});
  }
  private readable(native: NativeReadable): Readable {
    native.pause();
    const exposed = new Readable({
      highWaterMark: 64 * 1024,
      read: () => {
        native.resume();
      },
      destroy: (error, done) => {
        native.destroy();
        void afterClosed(native).then(() => done(error));
      },
    });
    const data = (bytes: Buffer) => {
      if (!exposed.push(bytes)) native.pause();
    };
    const end = () => exposed.push(null);
    const error = () => exposed.destroy(closed());
    const nativeClose = () => {
      if (!native.readableEnded && !exposed.destroyed) exposed.destroy(closed());
    };
    native.on('data', data);
    native.once('end', end);
    native.once('error', error);
    native.once('close', nativeClose);
    exposed.once('close', () => {
      native.off('data', data);
      native.off('end', end);
      native.off('error', error);
      native.off('close', nativeClose);
    });
    this.track(native, exposed);
    return exposed;
  }
  private writable(native: NativeWritable): Writable {
    let finalRequested = false;
    const exposed = new Writable({
      highWaterMark: 64 * 1024,
      write: (bytes, encoding, done) => {
        native.write(bytes, encoding, (error) => done(error ? closed() : undefined));
      },
      final: (done) => {
        finalRequested = true;
        // ssh2 destroys in _final before finish, so Node finished() misclassifies a
        // successful empty write. All write callbacks have acknowledged by here;
        // the file handle's actual close (or failed destroy callback) is the barrier.
        const drained = afterClosed(native);
        native.end();
        void drained.then(() => done(native.errored || this.signal.aborted ? closed() : undefined));
      },
      destroy: (error, done) => {
        native.destroy();
        void afterClosed(native).then(() => done(error));
      },
    });
    const error = () => exposed.destroy(closed());
    const nativeClose = () => {
      if (!finalRequested && !exposed.destroyed) exposed.destroy(closed());
    };
    native.once('error', error);
    native.once('close', nativeClose);
    exposed.once('close', () => {
      native.off('error', error);
      native.off('close', nativeClose);
    });
    this.track(native, exposed);
    return exposed;
  }
}
