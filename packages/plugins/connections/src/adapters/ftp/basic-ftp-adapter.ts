import { posix } from 'node:path';
import { PassThrough, Writable, type Readable, type Duplex } from 'node:stream';
import {
  Client,
  FTPError,
  type AccessOptions,
  type FileInfo,
  type TransferStrategy,
} from 'basic-ftp';
import iconv from 'iconv-lite';
import type { FtpFileHandle, FtpTransport } from '../../ports/ftp-transport.ts';
import {
  RemoteFileCapabilityUnavailableError,
  type RemoteFileAttributes,
  type RemoteFilesystemEntry,
} from '@axterm/plugin-api/host';

import { waitStreamClosed } from '../stream-lifetime.ts';
import { ApplicationError } from '../../application/errors.ts';

export const FTP_MAX_LISTING_BYTES = 16 * 1024 * 1024;
export const FTP_MAX_LISTING_ENTRIES = 20_000;
const drains = new WeakMap<BasicFtpClient, Promise<void>>();
const dataSockets = new WeakMap<BasicFtpClient, Set<Duplex>>();
async function drainData(client: BasicFtpClient): Promise<void> {
  const sockets = dataSockets.get(client);
  if (!sockets) return;
  await Promise.all(
    [...sockets].map(async (socket) => {
      await waitStreamClosed(socket);
      sockets.delete(socket);
    }),
  );
}
function drainClient(client: BasicFtpClient): Promise<void> {
  const previous = drains.get(client);
  if (previous) return previous;
  const sockets = [
    ...new Set(
      [client.ftp.socket, client.ftp.dataSocket, ...(dataSockets.get(client) ?? [])].filter(
        (socket): socket is Duplex => !!socket,
      ),
    ),
  ];
  const deferred = Promise.withResolvers<void>();
  drains.set(client, deferred.promise);
  try {
    client.close();
    const waits = sockets.map((socket) => {
      socket.destroy();
      return waitStreamClosed(socket);
    });
    void Promise.all(waits).then(
      () => deferred.resolve(),
      (error) => deferred.reject(error),
    );
  } catch (error) {
    deferred.reject(error);
  }
  return deferred.promise;
}
function boundedClient(timeout: number): BasicFtpClient {
  const client = new Client(timeout, {
    maxListingBytes: FTP_MAX_LISTING_BYTES,
    allowSeparateTransferHost: false,
  });
  const sockets = new Set<Duplex>();
  dataSockets.set(client, sockets);
  const wrap =
    (strategy: TransferStrategy): TransferStrategy =>
    async (ftp) => {
      try {
        return await strategy(ftp);
      } finally {
        if (ftp.dataSocket) sockets.add(ftp.dataSocket);
      }
    };
  let strategy = wrap(client.prepareTransfer);
  // The library caches its chosen strategy by assigning this public extension
  // point. Preserve that behavior while retaining each actual data socket.
  Object.defineProperty(client, 'prepareTransfer', {
    configurable: true,
    get: () => strategy,
    set: (next: TransferStrategy) => {
      strategy = wrap(next);
    },
  });
  const parse = client.parseList.bind(client);
  client.parseList = (raw) => {
    let lines = 0;
    for (let index = 0; index < raw.length; index++)
      if (raw.charCodeAt(index) === 10 && ++lines > FTP_MAX_LISTING_ENTRIES + 2)
        throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP directory entry limit exceeded', 503);
    const entries = parse(raw);
    if (entries.length > FTP_MAX_LISTING_ENTRIES)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP directory entry limit exceeded', 503);
    return entries;
  };
  return client;
}

type SupportedEncoding = Parameters<typeof iconv.encode>[1];

export interface BasicFtpClient {
  readonly ftp: {
    encoding: string | undefined;
    readonly socket?: Duplex;
    readonly dataSocket?: Duplex | undefined;
  };
  readonly closed: boolean;
  access(options: AccessOptions): Promise<unknown>;
  pwd(): Promise<string>;
  cd(path: string): Promise<unknown>;
  list(path?: string): Promise<FileInfo[]>;
  rename(from: string, to: string): Promise<unknown>;
  remove(path: string, ignoreErrorCodes?: boolean): Promise<unknown>;
  send(command: string): Promise<unknown>;
  uploadFrom(source: Readable, path: string): Promise<unknown>;
  appendFrom(source: Readable, path: string): Promise<unknown>;
  downloadTo(destination: Writable, path: string, startAt?: number): Promise<unknown>;
  close(): void;
}

export class BasicFtpAdapter implements FtpTransport {
  constructor(
    private readonly createClient: (timeoutMs: number) => BasicFtpClient = (timeout) =>
      boundedClient(timeout),
  ) {}

  async connect(input: Parameters<FtpTransport['connect']>[0]): Promise<FtpFileHandle> {
    input.signal?.throwIfAborted();
    const client = this.createClient(input.timeoutMs);
    const abort = () => {
      void drainClient(client).catch(() => {});
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const encoding = input.encoding as SupportedEncoding;
      if (!iconv.encodingExists(encoding))
        throw new Error(`Unsupported FTP encoding: ${input.encoding}`);
      if (input.encoding !== 'utf-8') client.ftp.encoding = 'latin1';
      await client.access({
        host: input.host,
        port: input.port,
        user: input.username,
        ...(input.password === undefined ? {} : { password: input.password }),
        secure:
          input.security === 'plain'
            ? false
            : input.security === 'implicit-tls'
              ? 'implicit'
              : true,
        ...(input.security === 'plain'
          ? {}
          : { secureOptions: { rejectUnauthorized: input.tlsVerify, servername: input.host } }),
      });
      input.signal?.throwIfAborted();
      return new BasicFtpHandle(client, encoding);
    } catch (error) {
      await drainClient(client);
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

class BasicFtpHandle implements FtpFileHandle {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly client: BasicFtpClient,
    private readonly encoding: SupportedEncoding,
  ) {}

  pwd(): Promise<string> {
    return this.enqueue(async () => this.decode(await this.client.pwd()));
  }

  async realpath(path: string): Promise<string> {
    this.assertCommandPath(path);
    return this.enqueue(async () => posix.resolve(this.decode(await this.client.pwd()), path));
  }

  async cd(path: string): Promise<void> {
    const encoded = this.commandPath(path);
    await this.enqueue(() => this.client.cd(encoded).then(() => undefined));
  }

  async list(path: string): Promise<RemoteFilesystemEntry[]> {
    const encoded = this.commandPath(path);
    return this.enqueue(async () =>
      (await this.listBounded(encoded)).map((entry) => ({
        filename: this.decode(entry.name),
        attrs: attributes(entry),
      })),
    );
  }

  async stat(path: string): Promise<RemoteFileAttributes> {
    return this.lstat(path);
  }

  async lstat(path: string): Promise<RemoteFileAttributes> {
    this.assertCommandPath(path);
    return this.enqueue(async () => {
      if (path === '/') return directoryAttributes();
      const name = posix.basename(path);
      const parent = posix.dirname(path);
      const entry = (await this.listBounded(this.commandPath(parent))).find(
        (candidate) => this.decode(candidate.name) === name,
      );
      if (!entry) throw new ApplicationError('NOT_FOUND', 'FTP path not found', 404);
      return attributes(entry);
    });
  }

  async mkdir(path: string): Promise<void> {
    const encoded = this.commandPath(path);
    await this.enqueue(() => this.client.send(`MKD ${encoded}`).then(() => undefined));
  }

  async rename(from: string, to: string): Promise<void> {
    const encodedFrom = this.commandPath(from);
    const encodedTo = this.commandPath(to);
    await this.enqueue(() => this.client.rename(encodedFrom, encodedTo).then(() => undefined));
  }

  async replace(from: string, to: string): Promise<void> {
    this.assertCommandPath(from);
    this.assertCommandPath(to);
    // A server may support RNTO over an existing destination. Never delete
    // that destination first: a refused or interrupted rename would otherwise
    // destroy the original text while the caller still believes it is safe.
    try {
      await this.rename(from, to);
    } catch (error) {
      // A permanent FTP refusal means there is no safe replacement for this
      // target. Preserve unexpected transport failures as-is: a disconnect
      // may leave the server-side rename outcome unknown.
      if (error instanceof FTPError && [550, 553].includes(error.code))
        throw new RemoteFileCapabilityUnavailableError('atomic-replace');
      throw error;
    }
  }

  async unlink(path: string): Promise<void> {
    const encoded = this.commandPath(path);
    await this.enqueue(() => this.client.remove(encoded).then(() => undefined));
  }

  async rmdir(path: string): Promise<void> {
    const encoded = this.commandPath(path);
    await this.enqueue(() => this.client.send(`RMD ${encoded}`).then(() => undefined));
  }

  async chmod(path: string, mode: number): Promise<void> {
    const encoded = this.commandPath(path);
    await this.enqueue(() =>
      this.client
        .send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${encoded}`)
        .then(() => undefined),
    );
  }

  readStream(path: string, options?: { start?: number; end?: number }): Readable {
    const encoded = this.commandPath(path);
    const start = options?.start ?? 0;
    const end = options?.end;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < start))
    )
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid FTP read range', 400);
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    let remaining = end === undefined ? Infinity : end - start + 1;
    let rangeComplete = false;
    const sink = new Writable({
      highWaterMark: 64 * 1024,
      write: (chunk: Buffer, _encoding, callback) => {
        const bytes = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= bytes.length;
        if (remaining === 0) rangeComplete = true;
        const accepted = output.write(bytes);
        if (accepted) callback();
        else output.once('drain', callback);
        if (rangeComplete) void drainClient(this.client).catch(() => {});
      },
    });
    sink.on('error', () => {});
    void this.enqueue(async () => {
      try {
        await this.client.downloadTo(sink, encoded, start);
      } catch (error) {
        if (!rangeComplete) throw error;
      } finally {
        sink.destroy();
      }
    }).then(
      () => output.end(),
      (error: unknown) => output.destroy(asError(error)),
    );
    output.once('close', () => {
      if (!output.readableEnded) {
        sink.destroy();
        void drainClient(this.client).catch(() => {});
      }
    });
    return output;
  }

  writeStream(path: string, options?: { flags?: 'w' | 'wx' | 'a'; mode?: number }): Writable {
    const encoded = this.commandPath(path);
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    source.on('error', () => {});
    let uploadSettled = false;
    const upload = this.enqueue(async () => {
      if (options?.flags === 'wx') {
        const entries = await this.listBounded(this.commandPath(posix.dirname(path)));
        if (entries.some((entry) => this.decode(entry.name) === posix.basename(path)))
          throw new ApplicationError('CONFLICT', 'FTP destination already exists', 409);
      }
      await (options?.flags === 'a'
        ? this.client.appendFrom(source, encoded)
        : this.client.uploadFrom(source, encoded));
      if (options?.mode !== undefined)
        await this.client.send(
          `SITE CHMOD ${(options.mode & 0o7777).toString(8).padStart(3, '0')} ${encoded}`,
        );
    });
    const output = new Writable({
      highWaterMark: 64 * 1024,
      write: (chunk, encoding, callback) => {
        source.write(chunk, encoding, callback);
      },
      final: (callback) => {
        source.end();
        void upload.then(
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
      destroy: (error, callback) => {
        source.destroy();
        const cleanup = uploadSettled ? Promise.resolve() : drainClient(this.client);
        void Promise.allSettled([upload, cleanup]).then(() => callback(error));
      },
    });
    // Observe early failures even when a producer is blocked by backpressure and
    // never reaches _final. _destroy joins the actual transfer and socket drains.
    void upload.then(
      () => {
        uploadSettled = true;
      },
      (error: unknown) => {
        uploadSettled = true;
        output.destroy(asError(error));
      },
    );
    return output;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return (this.closing = (async () => {
      const sockets = drainClient(this.client);
      await this.queue.catch(() => {});
      await sockets;
    })());
  }
  private async listBounded(path: string): Promise<FileInfo[]> {
    let entries: FileInfo[];
    try {
      entries = await this.client.list(path);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('StringWriter: Maximum bytes exceeded,')
      )
        throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP directory byte limit exceeded', 503);
      throw error;
    }
    if (entries.length > FTP_MAX_LISTING_ENTRIES)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'FTP directory entry limit exceeded', 503);
    return entries;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.client.closed) return Promise.reject(new Error('FTP client is closed'));
    const result = this.queue.then(async () => {
      try {
        return await operation();
      } finally {
        await drainData(this.client);
      }
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private encode(value: string): string {
    return this.encoding === 'utf-8'
      ? value
      : iconv.encode(value, this.encoding).toString('latin1');
  }

  private decode(value: string): string {
    return this.encoding === 'utf-8'
      ? value
      : iconv.decode(Buffer.from(value, 'latin1'), this.encoding);
  }

  private assertCommandPath(path: string): void {
    if (/\0|\r|\n/u.test(path))
      throw new Error('FTP paths cannot contain NUL, carriage-return or line-feed characters');
  }

  private commandPath(path: string): string {
    this.assertCommandPath(path);
    const encoded = this.encode(path);
    if (/\0|\r|\n/u.test(encoded))
      throw new Error('FTP path encoding contains a control character');
    return encoded;
  }
}

function attributes(entry: FileInfo): RemoteFileAttributes {
  const modified = entry.modifiedAt?.getTime() ?? 0;
  return {
    size: Math.max(0, entry.size),
    mode: permissionMode(entry),
    atime: Math.floor(modified / 1_000),
    mtime: Math.floor(modified / 1_000),
    uid: 0,
    gid: 0,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymbolicLink,
  };
}

function directoryAttributes(): RemoteFileAttributes {
  return {
    size: 0,
    mode: 0o755,
    atime: 0,
    mtime: 0,
    uid: 0,
    gid: 0,
    isFile: false,
    isDirectory: true,
    isSymbolicLink: false,
  };
}

function permissionMode(entry: FileInfo): number {
  const permissions = entry.permissions;
  if (!permissions) return entry.isDirectory ? 0o755 : 0o644;
  return (permissions.user << 6) | (permissions.group << 3) | permissions.world;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('FTP operation failed');
}
