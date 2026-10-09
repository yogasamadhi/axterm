import { posix } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { Client, FTPError, type AccessOptions, type FileInfo } from 'basic-ftp';
import iconv from 'iconv-lite';
import type { FtpFileHandle, FtpTransport } from '../../ports/ftp-transport';
import {
  SftpCapabilityUnavailableError,
  type SftpAttributes,
  type SftpEntry,
} from '../../ports/ssh-transport';

type SupportedEncoding = Parameters<typeof iconv.encode>[1];

export interface BasicFtpClient {
  readonly ftp: { encoding: string | undefined };
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
      new Client(timeout),
  ) {}

  async connect(input: Parameters<FtpTransport['connect']>[0]): Promise<FtpFileHandle> {
    input.signal?.throwIfAborted();
    const client = this.createClient(input.timeoutMs);
    const abort = () => client.close();
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
      client.close();
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

class BasicFtpHandle implements FtpFileHandle {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

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

  async list(path: string): Promise<SftpEntry[]> {
    const encoded = this.commandPath(path);
    return this.enqueue(async () =>
      (await this.client.list(encoded)).map((entry) => ({
        filename: this.decode(entry.name),
        attrs: attributes(entry),
      })),
    );
  }

  async stat(path: string): Promise<SftpAttributes> {
    return this.lstat(path);
  }

  async lstat(path: string): Promise<SftpAttributes> {
    this.assertCommandPath(path);
    return this.enqueue(async () => {
      if (path === '/') return directoryAttributes();
      const name = posix.basename(path);
      const parent = posix.dirname(path);
      const entry = (await this.client.list(this.commandPath(parent))).find(
        (candidate) => this.decode(candidate.name) === name,
      );
      if (!entry) throw new Error(`FTP path not found: ${path}`);
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
        throw new SftpCapabilityUnavailableError('atomic-replace');
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

  readStream(path: string, options?: { start?: number }): Readable {
    const encoded = this.commandPath(path);
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    void this.enqueue(() =>
      this.client.downloadTo(output, encoded, options?.start ?? 0).then(() => undefined),
    ).catch((error: unknown) => output.destroy(asError(error)));
    // A consumer may cancel a download with destroy() and no Error. That does
    // not emit `error`, but it must still tear down basic-ftp's in-flight data
    // transfer; otherwise its serialized command queue can wait indefinitely
    // for a peer that is still sending. A normally ended readable remains
    // reusable for later commands.
    output.once('close', () => {
      if (!output.readableEnded) this.client.close();
    });
    return output;
  }

  writeStream(path: string, options?: { flags?: 'w' | 'wx' | 'a' }): Writable {
    const encoded = this.commandPath(path);
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    let uploadSettled = false;
    const upload = this.enqueue(() =>
      (options?.flags === 'a'
        ? this.client.appendFrom(source, encoded)
        : this.client.uploadFrom(source, encoded)
      ).then(() => undefined),
    );
    return new Writable({
      highWaterMark: 64 * 1024,
      write: (chunk, encoding, callback) => {
        if (source.write(chunk, encoding)) callback();
        else source.once('drain', callback);
      },
      final: (callback) => {
        source.end();
        void upload.then(
          () => {
            uploadSettled = true;
            callback();
          },
          (error: unknown) => {
            uploadSettled = true;
            callback(asError(error));
          },
        );
      },
      destroy: (error, callback) => {
        source.destroy(error ?? undefined);
        // Writable auto-destroy also invokes this hook after a successful
        // final callback. Only a still-pending upload represents an explicit
        // cancellation/failure that must close the shared FTP data channel.
        if (!uploadSettled) this.client.close();
        callback(error);
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.close();
    await this.queue.catch(() => {});
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.client.closed) return Promise.reject(new Error('FTP client is closed'));
    const result = this.queue.then(operation);
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

function attributes(entry: FileInfo): SftpAttributes {
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

function directoryAttributes(): SftpAttributes {
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
