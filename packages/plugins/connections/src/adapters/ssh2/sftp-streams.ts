import { Readable, Writable } from 'node:stream';
import type { SFTPWrapper, OpenMode } from 'ssh2';
import { ApplicationError } from '../../application/errors.ts';
const CHUNK_BYTES = 64 * 1024;
type File = {
  sftp: SFTPWrapper;
  path: string;
  opening: Promise<Buffer> | undefined;
  handle: Buffer | undefined;
  inflight: Promise<unknown> | undefined;
  closing: Promise<void> | undefined;
};
function openFile(file: File, flags: OpenMode, mode?: number): Promise<Buffer> {
  return (file.opening ??= new Promise<Buffer>((resolve, reject) => {
    const opened = (error: Error | undefined, handle: Buffer) => {
      if (error) reject(error);
      else {
        file.handle = handle;
        resolve(handle);
      }
    };
    if (mode === undefined) file.sftp.open(file.path, flags, opened);
    else file.sftp.open(file.path, flags, mode, opened);
  }));
}
function closeFile(file: File): Promise<void> {
  return (file.closing ??= (async () => {
    // OPEN and every callback stay owned even when the channel has already closed.
    await file.opening?.catch(() => {});
    await file.inflight?.catch(() => {});
    const handle = file.handle;
    if (!handle) return;
    file.handle = undefined;
    await new Promise<void>((resolve, reject) =>
      file.sftp.close(handle, (error) => (error ? reject(error) : resolve())),
    );
  })());
}
function position(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new ApplicationError('VALIDATION_ERROR', 'Invalid SFTP stream position', 400);
}
export function sftpReadable(
  sftp: SFTPWrapper,
  path: string,
  options?: { start?: number; end?: number },
): Readable {
  position(options?.start);
  position(options?.end);
  if (options?.end !== undefined && options.end < (options.start ?? 0))
    throw new ApplicationError('VALIDATION_ERROR', 'Invalid SFTP read range', 400);
  const file: File = {
    sftp,
    path,
    opening: undefined,
    handle: undefined,
    inflight: undefined,
    closing: undefined,
  };
  let offset = options?.start ?? 0;
  const stream = new Readable({
    highWaterMark: CHUNK_BYTES,
    read() {
      if (stream.destroyed) return;
      const operation = (async () => {
        const handle = await openFile(file, 'r');
        if (stream.destroyed) return;
        const length =
          options?.end === undefined
            ? CHUNK_BYTES
            : Math.min(CHUNK_BYTES, options.end - offset + 1);
        if (length <= 0) {
          stream.push(null);
          return;
        }
        const bytes = Buffer.allocUnsafe(length);
        const count = await new Promise<number>((resolve, reject) =>
          sftp.read(handle, bytes, 0, length, offset, (error, count) =>
            error ? reject(error) : resolve(count),
          ),
        );
        if (!Number.isInteger(count) || count < 0 || count > length)
          throw new Error('Invalid SFTP read size');
        offset += count;
        if (!stream.destroyed) stream.push(count ? bytes.subarray(0, count) : null);
      })();
      file.inflight = operation;
      void operation.then(
        () => {},
        (error) => {
          stream.destroy(error instanceof Error ? error : new Error('SFTP read failed'));
        },
      );
    },
    destroy(error, done) {
      void closeFile(file).then(
        () => done(error),
        (failure) =>
          done(error ?? (failure instanceof Error ? failure : new Error('SFTP close failed'))),
      );
    },
  });
  return stream;
}
export function sftpWritable(
  sftp: SFTPWrapper,
  path: string,
  options?: { flags?: 'w' | 'wx' | 'a'; mode?: number },
): Writable {
  const mode = options?.mode ?? 0o666;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
    throw new ApplicationError('VALIDATION_ERROR', 'Invalid SFTP stream mode', 400);
  const file: File = {
    sftp,
    path,
    opening: undefined,
    handle: undefined,
    inflight: undefined,
    closing: undefined,
  };
  let offset = 0;
  let prepared: Promise<Buffer> | undefined;
  const prepare = () =>
    (prepared ??= (async () => {
      const handle = await openFile(file, options?.flags ?? 'w', mode);
      if (stream.destroyed) return handle;
      await new Promise<void>((resolve, reject) =>
        sftp.fchmod(handle, mode, (error) => {
          if (!error) resolve();
          else sftp.chmod(path, mode, (fallback) => (fallback ? reject(fallback) : resolve()));
        }),
      );
      if (options?.flags === 'a') {
        const metadata = await new Promise<{ size: number }>((resolve, reject) =>
          sftp.fstat(handle, (error, value) => (error ? reject(error) : resolve(value))),
        );
        position(metadata.size);
        offset = metadata.size;
      }
      return handle;
    })());
  const stream = new Writable({
    highWaterMark: CHUNK_BYTES,
    write(bytes: Buffer, _encoding, done) {
      const operation = (async () => {
        const handle = await prepare();
        if (stream.destroyed) return;
        for (let index = 0; index < bytes.length;) {
          if (stream.destroyed) return;
          const length = Math.min(CHUNK_BYTES, bytes.length - index);
          await new Promise<void>((resolve, reject) =>
            sftp.write(handle, bytes, index, length, offset, (error) =>
              error ? reject(error) : resolve(),
            ),
          );
          index += length;
          offset += length;
        }
      })();
      file.inflight = operation;
      void operation.then(
        () => done(),
        (error) => done(error instanceof Error ? error : new Error('SFTP write failed')),
      );
    },
    final(done) {
      const operation = prepare();
      file.inflight = operation;
      void operation
        .then(() => closeFile(file))
        .then(
          () => done(),
          (error) => done(error instanceof Error ? error : new Error('SFTP finalization failed')),
        );
    },
    destroy(error, done) {
      void closeFile(file).then(
        () => done(error),
        (failure) =>
          done(error ?? (failure instanceof Error ? failure : new Error('SFTP close failed'))),
      );
    },
  });
  return stream;
}
