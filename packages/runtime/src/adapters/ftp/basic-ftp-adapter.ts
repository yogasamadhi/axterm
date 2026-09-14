import { posix } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { Client, type AccessOptions, type FileInfo } from 'basic-ftp';
import iconv from 'iconv-lite';
import type { FtpFileHandle, FtpTransport } from '../../ports/ftp-transport';
import type { SftpAttributes, SftpEntry } from '../../ports/ssh-transport';

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

  realpath(path: string): Promise<string> {
    return this.enqueue(async () => posix.resolve(this.decode(await this.client.pwd()), path));
  }

  async cd(path: string): Promise<void> {
    await this.enqueue(() => this.client.cd(this.encode(path)).then(() => undefined));
  }

  list(path: string): Promise<SftpEntry[]> {
    return this.enqueue(async () =>
      (await this.client.list(this.encode(path))).map((entry) => ({
        filename: this.decode(entry.name),
        attrs: attributes(entry),
      })),
    );
  }

  async stat(path: string): Promise<SftpAttributes> {
    return this.lstat(path);
  }

  lstat(path: string): Promise<SftpAttributes> {
    return this.enqueue(async () => {
      if (path === '/') return directoryAttributes();
      const name = posix.basename(path);
      const parent = posix.dirname(path);
      const entry = (await this.client.list(this.encode(parent))).find(
        (candidate) => this.decode(candidate.name) === name,
      );
      if (!entry) throw new Error(`FTP path not found: ${path}`);
      return attributes(entry);
    });
  }

  async mkdir(path: string): Promise<void> {
    await this.enqueue(() => this.client.send(`MKD ${this.encode(path)}`).then(() => undefined));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.enqueue(() =>
      this.client.rename(this.encode(from), this.encode(to)).then(() => undefined),
    );
  }

  async replace(from: string, to: string): Promise<void> {
    await this.unlink(to).catch(() => {});
    await this.rename(from, to);
  }

  async unlink(path: string): Promise<void> {
    await this.enqueue(() => this.client.remove(this.encode(path)).then(() => undefined));
  }

  async rmdir(path: string): Promise<void> {
    await this.enqueue(() => this.client.send(`RMD ${this.encode(path)}`).then(() => undefined));
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.enqueue(() =>
      this.client
        .send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${this.encode(path)}`)
        .then(() => undefined),
    );
  }

  readStream(path: string, options?: { start?: number }): Readable {
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    void this.enqueue(() =>
      this.client.downloadTo(output, this.encode(path), options?.start ?? 0).then(() => undefined),
    ).catch((error: unknown) => output.destroy(asError(error)));
    output.once('error', () => this.client.close());
    return output;
  }

  writeStream(path: string, options?: { flags?: 'w' | 'wx' | 'a' }): Writable {
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    const upload = this.enqueue(() =>
      (options?.flags === 'a'
        ? this.client.appendFrom(source, this.encode(path))
        : this.client.uploadFrom(source, this.encode(path))
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
          () => callback(),
          (error: unknown) => callback(asError(error)),
        );
      },
      destroy: (error, callback) => {
        source.destroy(error ?? undefined);
        if (error) this.client.close();
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
