import { once } from 'node:events';
import type { SFTPWrapper } from 'ssh2';
import { expect, it, vi } from 'vitest';
import { sftpReadable, sftpWritable } from './sftp-streams.ts';

it('retains a canceled read until a late OPEN and its actual CLOSE callback drain', async () => {
  let opened: ((error: Error | undefined, handle: Buffer) => void) | undefined;
  let closed: ((error?: Error) => void) | undefined;
  const handle = Buffer.from('late');
  const open = vi.fn((_path: string, _flags: string, callback: typeof opened) => {
    opened = callback;
  });
  const close = vi.fn((_handle: Buffer, callback: typeof closed) => {
    closed = callback;
  });
  const sftp = { open, close } as unknown as SFTPWrapper;
  const read = sftpReadable(sftp, '/late');
  read.on('error', () => {});
  read.resume();
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  const released = vi.fn();
  const drained = once(read, 'close').then(released);
  read.destroy();
  await Promise.resolve();
  expect(released).not.toHaveBeenCalled();
  opened!(undefined, handle);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(released).not.toHaveBeenCalled();
  closed!();
  await drained;
  expect(read.closed).toBe(true);
  expect(close).toHaveBeenCalledWith(handle, expect.any(Function));
});

it('drains a canceled write when OPEN fails instead of waiting for an open event that cannot arrive', async () => {
  let opened: ((error: Error | undefined, handle: Buffer) => void) | undefined;
  const sftp = {
    open: vi.fn((_path: string, _flags: string, _mode: number, callback: typeof opened) => {
      opened = callback;
    }),
    close: vi.fn(),
  } as unknown as SFTPWrapper;
  const write = sftpWritable(sftp, '/late', { flags: 'wx', mode: 0o600 });
  write.on('error', () => {});
  const drained = new Promise<void>((resolve) => write.once('close', resolve));
  write.write(Buffer.from('pending'));
  write.destroy();
  await vi.waitFor(() => expect(opened).toBeDefined());
  opened!(new Error('Channel closed'), Buffer.alloc(0));
  await drained;
  expect(write.closed).toBe(true);
  expect(sftp.close).not.toHaveBeenCalled();
});

it('bounds raw read requests and preserves an inclusive byte range', async () => {
  const source = Buffer.from('0123456789');
  const calls: Array<{ length: number; offset: number }> = [];
  const sftp = {
    open: (_path: string, _flags: string, callback: (error: undefined, handle: Buffer) => void) =>
      callback(undefined, Buffer.from('file')),
    read: (
      _handle: Buffer,
      bytes: Buffer,
      _start: number,
      length: number,
      offset: number,
      callback: (error: undefined, count: number) => void,
    ) => {
      calls.push({ length, offset });
      const count = source.copy(bytes, 0, offset, Math.min(source.length, offset + length));
      callback(undefined, count);
    },
    close: (_handle: Buffer, callback: () => void) => callback(),
  } as unknown as SFTPWrapper;
  const chunks: Buffer[] = [];
  for await (const chunk of sftpReadable(sftp, '/range', { start: 2, end: 5 }))
    chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('2345');
  expect(calls).toEqual([{ length: 4, offset: 2 }]);
  expect(() => sftpReadable(sftp, '/range', { start: 5, end: 2 })).toThrow();
});

it('joins cancellation with an already pending final file CLOSE', async () => {
  let closeCallback: (() => void) | undefined;
  const close = vi.fn((_handle: Buffer, callback: () => void) => {
    closeCallback = callback;
  });
  const sftp = {
    open: (
      _path: string,
      _flags: string,
      _mode: number,
      callback: (error: undefined, handle: Buffer) => void,
    ) => callback(undefined, Buffer.from('empty')),
    fchmod: (_handle: Buffer, _mode: number, callback: () => void) => callback(),
    close,
  } as unknown as SFTPWrapper;
  const stream = sftpWritable(sftp, '/empty', { flags: 'wx' });
  stream.on('error', () => {});
  const released = vi.fn();
  const drained = once(stream, 'close').then(released);
  stream.end();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  stream.destroy();
  await Promise.resolve();
  expect(released).not.toHaveBeenCalled();
  closeCallback!();
  await drained;
  expect(close).toHaveBeenCalledOnce();
});
