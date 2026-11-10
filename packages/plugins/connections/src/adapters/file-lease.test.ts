import { once } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RemoteFilesystem } from '@axterm/plugin-api/host';
import { describe, expect, it, vi } from 'vitest';
import { OwnedFileLease } from './file-lease.ts';

function fixture(overrides: Partial<RemoteFilesystem> = {}) {
  const native: RemoteFilesystem = {
    realpath: async (path) => path,
    list: async () => [],
    stat: vi.fn(),
    lstat: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    replace: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    chmod: vi.fn(),
    readStream: () => Readable.from([Buffer.from('data')]),
    writeStream: () =>
      new Writable({
        write(_bytes, _encoding, done) {
          done();
        },
      }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  const released = vi.fn();
  const abort = new AbortController();
  const lease = new OwnedFileLease(native, abort.signal, released);
  return { native, released, abort, lease };
}

describe('owned SFTP leases', () => {
  it('exposes bounded stream facades and drains actual read/write streams', async () => {
    const read = Readable.from([Buffer.from('hello')]);
    const chunks: Buffer[] = [];
    const write = new Writable({
      write(bytes, _encoding, done) {
        chunks.push(Buffer.from(bytes));
        done();
      },
    });
    const { lease, released } = fixture({ readStream: () => read, writeStream: () => write });
    const exposedRead = lease.filesystem.readStream('/file');
    const exposedWrite = lease.filesystem.writeStream('/copy');
    expect(exposedRead).not.toBe(read);
    expect(exposedWrite).not.toBe(write);
    expect(exposedRead.readableHighWaterMark).toBe(64 * 1024);
    expect(exposedWrite.writableHighWaterMark).toBe(64 * 1024);
    await pipeline(exposedRead, exposedWrite);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    await lease.close();
    expect(read.closed && write.closed).toBe(true);
    expect(lease.resourceCount()).toBe(0);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('retains ownership until both actual stream close and late operation complete', async () => {
    const rpc = Promise.withResolvers<string>();
    const streamClose = Promise.withResolvers<void>();
    const nativeClose = Promise.withResolvers<void>();
    const read = new Readable({
      read() {},
      destroy(_error, done) {
        void streamClose.promise.then(() => done());
      },
    });
    const { lease, abort, released, native } = fixture({
      realpath: () => rpc.promise,
      readStream: () => read,
      close: () => nativeClose.promise,
    });
    const operation = lease.filesystem.realpath('.');
    const failed = expect(operation).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    await Promise.resolve();
    lease.filesystem.readStream('/pending');
    abort.abort();
    const closing = lease.close();
    expect(lease.close()).toBe(closing);
    nativeClose.resolve();
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    rpc.resolve('/late');
    await failed;
    expect(released).not.toHaveBeenCalled();
    streamClose.resolve();
    await closing;
    expect(released).toHaveBeenCalledTimes(1);
    expect(lease.resourceCount()).toBe(0);
    await expect(lease.filesystem.realpath('.')).rejects.toMatchObject({
      code: 'REQUEST_CANCELED',
    });
    expect(() => lease.filesystem.readStream('/new')).toThrow();
    expect(native).toBeDefined();
  });

  it('bounds outstanding operations and streams before admitting vendor work', async () => {
    const rpc = Promise.withResolvers<string>();
    const call = vi.fn(() => rpc.promise);
    const { lease } = fixture({ realpath: call, readStream: () => new PassThrough() });
    const operations = Array.from({ length: 64 }, () => lease.filesystem.realpath('.'));
    const settled = Promise.allSettled(operations);
    await expect(lease.filesystem.realpath('.')).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    });
    for (let index = 0; index < 32; index++) lease.filesystem.readStream('/file');
    expect(() => lease.filesystem.readStream('/extra')).toThrow('capacity');
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(64);
    rpc.resolve('/root');
    await settled;
    await lease.close();
  });

  it('owns late errors and keeps failed native cleanup unreleased', async () => {
    const read = new PassThrough();
    const { lease, released } = fixture({
      readStream: () => read,
      close: async () => {
        throw new Error('private transport message');
      },
    });
    const exposed = lease.filesystem.readStream('/file');
    const closed = once(exposed, 'close');
    read.emit('error', new Error('secret'));
    await closed.catch(() => {});
    await expect(lease.close()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(released).not.toHaveBeenCalled();
  });
});
