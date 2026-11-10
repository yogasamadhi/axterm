import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import {
  Client,
  type AuthenticationType,
  type AuthHandlerMiddleware,
  type ClientChannel,
  type ConnectConfig,
  type ParsedKey,
  type SFTPWrapper,
  type Stats,
  type FileEntryWithStats,
} from 'ssh2';
import type {
  RemoteFileAttributes,
  RemoteFilesystemEntry,
  RemoteFilesystem,
  SshConnectionHandle,
  SshTransport,
} from '../../ports/ssh-transport.ts';
import { RemoteFileCapabilityUnavailableError } from '../../ports/ssh-transport.ts';
import type { TerminalChannel } from '../../ports/terminal-channel.ts';
import { connectLocalX11, resolveLocalX11, type ResolvedX11Forwarding } from './x11-forwarding.ts';
import { createCertificateIdentity } from './certificate-identity.ts';
import { probeSshAgent } from './ssh-agent.ts';
import { sftpReadable, sftpWritable } from './sftp-streams.ts';
import { waitStreamClosed } from '../stream-lifetime.ts';
import { ApplicationError, isApplicationError } from '../../application/errors.ts';

export const SSH_COMPRESSION_ALGORITHMS = ['zlib@openssh.com', 'zlib', 'none'] as const;

interface ManagedX11Forwarding {
  key: string;
  config: ResolvedX11Forwarding;
  users: number;
  handler: (
    details: { srcIP: string; srcPort: number },
    accept: () => ClientChannel | undefined,
    reject: () => void,
  ) => void;
  sockets: Set<{ local: Socket; remote?: ClientChannel }>;
}

export class Ssh2Transport implements SshTransport {
  constructor(private readonly createClient: () => Client = () => new Client()) {}

  agentStatus(path?: string) {
    return probeSshAgent(path);
  }

  async connect(input: Parameters<SshTransport['connect']>[0]): Promise<SshConnectionHandle> {
    const client = this.createClient();
    // A canceled host-key prompt may finish after destroy(). Keep errors owned until
    // the native connection closes, including the handoff between ready and its handle.
    let closed = false;
    let started = false;
    const drained = Promise.withResolvers<void>();
    const consumeLateError = () => {};
    const onClosed = () => {
      closed = true;
      client.off('error', consumeLateError);
      drained.resolve();
    };
    client.on('error', consumeLateError);
    client.once('close', onClosed);
    let certificateIdentity: ParsedKey | undefined;
    try {
      certificateIdentity =
        input.certificate && input.privateKey
          ? createCertificateIdentity(input.privateKey, input.certificate, input.passphrase)
          : undefined;
      if (input.certificate && !certificateIdentity) throw new Error('Missing private key');
    } catch {
      client.destroy();
      client.off('error', consumeLateError);
      client.off('close', onClosed);
      throw new ApplicationError(
        'SSH_KEY_INVALID',
        'SSH private key or certificate is invalid',
        400,
      );
    }
    let hostKeyRejected = false;
    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: input.connectionTimeoutMs,
      keepaliveInterval: input.keepaliveIntervalMs,
      keepaliveCountMax: input.keepaliveCountMax,
      tryKeyboard: true,
      authHandler: authenticationHandler(input, certificateIdentity),
      algorithms: {
        ...(input.algorithms.kex.length ? { kex: input.algorithms.kex } : {}),
        ...(input.algorithms.cipher.length ? { cipher: input.algorithms.cipher } : {}),
        ...(input.algorithms.serverHostKey.length
          ? { serverHostKey: input.algorithms.serverHostKey }
          : {}),
        ...(input.algorithms.hmac.length ? { hmac: input.algorithms.hmac } : {}),
        compress: input.compression ? [...SSH_COMPRESSION_ALGORITHMS] : ['none'],
      } as NonNullable<ConnectConfig['algorithms']>,
      hostVerifier(key: Buffer, verify: (valid: boolean) => void) {
        const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        void input
          .verifyHostKey({
            algorithm: hostKeyAlgorithm(key),
            fingerprint,
            publicKey: key.toString('base64'),
          })
          .then(
            (accepted) => {
              if (closed || input.signal?.aborted) return;
              hostKeyRejected = !accepted;
              verify(accepted);
            },
            () => {
              if (closed || input.signal?.aborted) return;
              hostKeyRejected = true;
              verify(false);
            },
          );
      },
      ...(input.password ? { password: input.password } : {}),
      ...(!certificateIdentity && input.privateKey ? { privateKey: input.privateKey } : {}),
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.socket ? { sock: input.socket } : {}),
    };
    const onKeyboardInteractive = (
      name: string,
      instructions: string,
      _language: string,
      prompts: Array<{ prompt: string; echo?: boolean }>,
      finish: (answers: string[]) => void,
    ) => {
      void input
        .keyboardInteractive({
          name,
          instructions,
          prompts: prompts.map((prompt) => ({ prompt: prompt.prompt, echo: prompt.echo ?? false })),
        })
        .then(
          (answers) => {
            if (!closed && !input.signal?.aborted) finish(answers);
          },
          () => {
            if (!closed && !input.signal?.aborted) finish([]);
          },
        );
    };
    client.on('keyboard-interactive', onKeyboardInteractive);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          input.signal?.removeEventListener('abort', onAbort);
          client.off('ready', onReady);
          client.off('error', onError);
        };
        const onReady = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          client.destroy();
          reject(input.signal?.reason ?? new Error('SSH connection canceled'));
        };
        if (input.signal?.aborted) return onAbort();
        input.signal?.addEventListener('abort', onAbort, { once: true });
        client.once('ready', onReady);
        client.once('error', onError);
        try {
          client.connect(config);
          started = true;
        } catch (error) {
          onError(error instanceof Error ? error : new Error('SSH connection failed'));
        }
      });
    } catch (error) {
      client.destroy();
      if (started) await drained.promise;
      else {
        client.off('error', consumeLateError);
        client.off('close', onClosed);
      }
      if (input.signal?.aborted) throw error;
      if (hostKeyRejected)
        throw new ApplicationError('HOST_KEY_REJECTED', 'SSH host key was not accepted');
      throw connectionError(error);
    } finally {
      client.off('keyboard-interactive', onKeyboardInteractive);
    }
    if (closed)
      throw new ApplicationError(
        'SSH_CONNECTION_LOST',
        'SSH connection closed before ready handoff',
        503,
      );
    const handle = new Ssh2ConnectionHandle(client);
    client.off('error', consumeLateError);
    client.off('close', onClosed);
    return handle;
  }
}

function connectionError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  const value = error instanceof Error ? error : undefined;
  const code = value && 'code' in value ? value.code : undefined;
  const level = value && 'level' in value ? value.level : undefined;
  if (level === 'client-authentication')
    return new ApplicationError('AUTHENTICATION_FAILED', 'SSH authentication failed');
  if (code === 'ECONNREFUSED')
    return new ApplicationError('SSH_CONNECTION_REFUSED', 'SSH connection was refused', 503);
  if (code === 'ETIMEDOUT' || level === 'client-timeout')
    return new ApplicationError('SSH_CONNECTION_TIMEOUT', 'SSH connection timed out', 503);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || level === 'client-dns')
    return new ApplicationError('SSH_DNS_FAILED', 'SSH hostname could not be resolved', 503);
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH')
    return new ApplicationError('SSH_NETWORK_UNREACHABLE', 'SSH network is unreachable', 503);
  if (code === 'ECONNRESET' || code === 'EPIPE')
    return new ApplicationError('SSH_CONNECTION_LOST', 'SSH connection was interrupted', 503);
  if (level === 'handshake')
    return new ApplicationError('SSH_NEGOTIATION_FAILED', 'SSH handshake failed', 503);
  if (value?.message.startsWith('Cannot parse privateKey:'))
    return new ApplicationError('SSH_KEY_INVALID', 'SSH private key is invalid', 400);
  return new ApplicationError(
    'SSH_CONNECTION_FAILED',
    'SSH connection could not be established',
    503,
  );
}

function hostKeyAlgorithm(key: Buffer): string {
  if (key.byteLength < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 128 || length + 4 > key.byteLength) return 'unknown';
  const algorithm = key.subarray(4, length + 4).toString('ascii');
  return /^[a-z0-9@._+-]+$/iu.test(algorithm) ? algorithm : 'unknown';
}

function authenticationHandler(
  input: Parameters<SshTransport['connect']>[0],
  certificateIdentity?: ParsedKey,
): AuthHandlerMiddleware {
  const order: AuthenticationType[] = ['none'];
  if (input.password !== undefined) order.push('password');
  if (input.privateKey !== undefined) order.push('publickey');
  if (input.agent !== undefined) order.push('agent');
  order.push('keyboard-interactive');
  let attempted = new Set<AuthenticationType>();
  return (methodsLeft, partialSuccess, next) => {
    if (partialSuccess) attempted = new Set();
    const allowed = new Set(methodsLeft?.length ? methodsLeft : order);
    const method = order.find(
      (candidate) =>
        (allowed.has(candidate) || (candidate === 'agent' && allowed.has('publickey'))) &&
        !attempted.has(candidate),
    );
    if (!method) return next(false as never);
    attempted.add(method);
    next(
      method === 'publickey' && certificateIdentity
        ? { type: 'publickey', username: input.username, key: certificateIdentity }
        : method,
    );
  };
}

type ForwardedDetails = { srcIP: string; srcPort: number; destIP: string; destPort: number };
type ForwardedHandler = (
  details: ForwardedDetails,
  accept: () => ClientChannel | undefined,
  reject: () => void,
) => void;
function forwardedHost(value: string): string {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes(':')) {
    try {
      return new URL(`http://[${host}]/`).hostname.slice(1, -1);
    } catch {
      return host;
    }
  }
  return host;
}
class Ssh2ConnectionHandle implements SshConnectionHandle {
  readonly id = randomUUID();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private closeError: Error | undefined;
  private readonly remoteHandlers = new Map<string, ForwardedHandler>();
  private x11Forwarding: ManagedX11Forwarding | undefined;
  constructor(private readonly client: Client) {
    client.on('error', this.onClientError);
    client.once('close', this.onClientClose);
    client.on('tcp connection', this.onForwardedConnection);
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => listener(this.closeError));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async openShell(input: {
    cols: number;
    rows: number;
    term: string;
    env: Record<string, string>;
    x11?: { display?: string };
  }): Promise<TerminalChannel> {
    const x11 = input.x11 ? await resolveLocalX11(input.x11.display) : undefined;
    const releaseX11 = x11 ? this.retainX11(x11) : undefined;
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.client.shell(
        { term: input.term, cols: input.cols, rows: input.rows },
        {
          env: input.env,
          ...(x11
            ? {
                x11: {
                  screen: x11.screen,
                  ...(x11.cookie ? { cookie: x11.cookie } : {}),
                },
              }
            : {}),
        },
        (error, stream) => {
          if (error) {
            releaseX11?.();
            reject(error);
          } else resolve(stream);
        },
      );
    });
    return channelAsTerminal(channel, () => this.client.destroy(), releaseX11);
  }

  async openSftp(signal?: AbortSignal): Promise<RemoteFilesystem> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // ssh2 supplies no cancellable handle until the subsystem callback. Give a
    // late reply a grace period, then terminate the owner to flush native callbacks.
    const canceled = () => {
      timer ??= setTimeout(() => this.client.destroy(), 1_000);
    };
    signal?.addEventListener('abort', canceled, { once: true });
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((error, handle) => (error ? reject(error) : resolve(handle)));
      });
      return sftpHandle(sftp, () => this.client.destroy());
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', canceled);
    }
  }

  exec(input: {
    command: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const limit = input.maxBytes ?? 1024 * 1024;
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let exitCode: number | null = null;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this.client.exec(input.command, (error, channel) => {
        if (error) return fail(error);
        const onAbort = () => {
          channel.close();
          fail(
            input.signal?.reason instanceof Error
              ? input.signal.reason
              : new Error('Command canceled'),
          );
        };
        input.signal?.addEventListener('abort', onAbort, { once: true });
        const append = (target: Buffer<ArrayBufferLike>, data: Buffer<ArrayBufferLike>) => {
          if (target.length + data.length > limit) {
            channel.close();
            fail(new Error('Command output exceeded limit'));
            return target;
          }
          return Buffer.concat([target, data]);
        };
        channel.on('data', (data: Buffer) => {
          stdout = append(stdout, data);
        });
        channel.stderr.on('data', (data: Buffer) => {
          stderr = append(stderr, data);
        });
        channel.on('exit', (code: number | undefined) => {
          exitCode = code ?? null;
        });
        channel.on('close', () => {
          input.signal?.removeEventListener('abort', onAbort);
          if (!settled) {
            settled = true;
            resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), exitCode });
          }
        });
        channel.on('error', fail);
      });
    });
  }

  forwardOut(
    source: { host: string; port: number },
    target: { host: string; port: number },
  ): Promise<NodeJS.ReadWriteStream> {
    if (this.closed) return Promise.reject(new Error('SSH_FORWARD_CONNECTION_CLOSED'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const unlisten = this.onClose(() => {
        if (settled) return;
        settled = true;
        unlisten();
        reject(new Error('SSH_FORWARD_CONNECTION_CLOSED'));
      });
      try {
        this.client.forwardOut(
          source.host,
          source.port,
          target.host,
          target.port,
          (error, channel) => {
            if (settled) {
              channel?.destroy();
              return;
            }
            settled = true;
            unlisten();
            if (error) reject(error);
            else resolve(channel);
          },
        );
      } catch (error) {
        settled = true;
        unlisten();
        reject(error);
      }
    });
  }

  forwardIn(
    host: string,
    port: number,
    listener: (
      info: {
        sourceHost: string;
        sourcePort: number;
        destinationHost: string;
        destinationPort: number;
      },
      channel: NodeJS.ReadWriteStream,
    ) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      this.client.forwardIn(host, port, (error, boundPort) => {
        if (error) return reject(error);
        const handler = (
          details: { srcIP: string; srcPort: number; destIP: string; destPort: number },
          accept: () => ClientChannel | undefined,
          rejectConnection: () => void,
        ) => {
          if (details.destPort !== boundPort) return;
          const channel = accept();
          if (!channel) return rejectConnection();
          listener(
            {
              sourceHost: details.srcIP,
              sourcePort: details.srcPort,
              destinationHost: details.destIP,
              destinationPort: details.destPort,
            },
            channel,
          );
        };
        const key = `${forwardedHost(host)}:${boundPort}`;
        if (this.remoteHandlers.has(key)) {
          void this.close();
          reject(
            new ApplicationError('CONFLICT', 'Remote forwarding address already has an owner'),
          );
          return;
        }
        this.remoteHandlers.set(key, handler);
        resolve(boundPort);
      });
    });
  }

  unforwardIn(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) =>
      this.client.unforwardIn(host, port, (error) => {
        if (error) return reject(error);
        this.remoteHandlers.delete(`${forwardedHost(host)}:${port}`);
        resolve();
      }),
    );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    return (this.closing = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.client.destroy();
      }, 1_000);
      this.client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.client.end();
    }));
  }

  private readonly onForwardedConnection = (
    details: ForwardedDetails,
    accept: () => ClientChannel | undefined,
    reject: () => void,
  ) => {
    const destination = forwardedHost(details.destIP);
    const exact = this.remoteHandlers.get(`${destination}:${details.destPort}`);
    if (exact) {
      exact(details, accept, reject);
      return;
    }
    const candidates = [
      this.remoteHandlers.get(
        `${destination.includes(':') ? '::' : '0.0.0.0'}:${details.destPort}`,
      ),
      this.remoteHandlers.get(`:${details.destPort}`),
      ...(['127.0.0.1', '::1'].includes(destination)
        ? [this.remoteHandlers.get(`localhost:${details.destPort}`)]
        : []),
    ].filter((handler): handler is ForwardedHandler => !!handler);
    if (candidates.length === 1) candidates[0]!(details, accept, reject);
    else reject();
  };
  private readonly onClientError = (error: Error) => {
    this.closeError = error;
  };

  private readonly onClientClose = () => {
    if (this.closed) return;
    this.closed = true;
    this.client.off('error', this.onClientError);
    for (const listener of this.closeListeners) listener(this.closeError);
    this.closeListeners.clear();
    this.client.off('tcp connection', this.onForwardedConnection);
    this.remoteHandlers.clear();
    this.disposeX11();
  };

  private retainX11(config: ResolvedX11Forwarding): () => void {
    const key = JSON.stringify(config);
    if (this.x11Forwarding && this.x11Forwarding.key !== key)
      throw new Error('An SSH connection cannot forward multiple local X11 displays');
    if (!this.x11Forwarding) {
      const forwarding: ManagedX11Forwarding = {
        key,
        config,
        users: 0,
        sockets: new Set<{ local: Socket; remote?: ClientChannel }>(),
        handler: () => {},
      };
      forwarding.handler = (_details, accept, reject) => {
        void connectLocalX11(forwarding.config.endpoint).then(
          (local) => {
            if (this.x11Forwarding !== forwarding || forwarding.users === 0) {
              local.destroy();
              reject();
              return;
            }
            let remote: ClientChannel | undefined;
            try {
              remote = accept();
            } catch {
              local.destroy();
              reject();
              return;
            }
            if (!remote) {
              local.destroy();
              reject();
              return;
            }
            const pair = { local, remote };
            forwarding.sockets.add(pair);
            const cleanup = () => {
              forwarding.sockets.delete(pair);
              local.destroy();
              remote?.destroy();
            };
            local.once('close', cleanup);
            local.once('error', cleanup);
            remote.once('close', cleanup);
            remote.once('error', cleanup);
            remote.pipe(local).pipe(remote);
          },
          () => reject(),
        );
      };
      this.x11Forwarding = forwarding;
      this.client.on('x11', forwarding.handler);
    }
    this.x11Forwarding.users += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.x11Forwarding || this.x11Forwarding.key !== key) return;
      this.x11Forwarding.users -= 1;
      if (this.x11Forwarding.users === 0) this.disposeX11();
    };
  }

  private disposeX11(): void {
    const forwarding = this.x11Forwarding;
    if (!forwarding) return;
    this.x11Forwarding = undefined;
    this.client.off('x11', forwarding.handler);
    for (const { local, remote } of forwarding.sockets) {
      local.destroy();
      remote?.destroy();
    }
    forwarding.sockets.clear();
  }
}

function channelAsTerminal(
  channel: ClientChannel,
  terminate: () => void,
  onClose?: () => void,
): TerminalChannel {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let exitCode: number | null = null;
  let closed = false;
  let closing: Promise<void> | undefined;
  const drained = Promise.withResolvers<void>();
  channel.on('data', (data: Buffer) => {
    for (const listener of dataListeners) listener(data);
  });
  channel.on('exit', (code: number | undefined) => {
    exitCode = code ?? null;
  });
  channel.on('close', () => {
    closed = true;
    for (const listener of exitListeners) listener(exitCode);
    dataListeners.clear();
    exitListeners.clear();
    onClose?.();
    drained.resolve();
  });
  return {
    write: (data) => {
      if (!closed) channel.write(data);
    },
    resize: (cols, rows) => {
      if (!closed) channel.setWindow(rows, cols, 0, 0);
    },
    signal: (signal) => {
      if (!closed) channel.signal(signal);
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    pause: () => channel.pause(),
    resume: () => channel.resume(),
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      return (closing = (async () => {
        const timer = setTimeout(terminate, 1_000);
        try {
          channel.close();
          await drained.promise;
        } finally {
          clearTimeout(timer);
        }
      })());
    },
  };
}

function attributes(stats: Stats): RemoteFileAttributes {
  return {
    size: stats.size,
    mode: stats.mode,
    atime: stats.atime,
    mtime: stats.mtime,
    uid: stats.uid,
    gid: stats.gid,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}
function sftpHandle(sftp: SFTPWrapper, terminate: () => void): RemoteFilesystem {
  const streams = new Set<Readable | Writable>();
  let ended = false;
  let closing: Promise<void> | undefined;
  const drained = Promise.withResolvers<void>();
  const ownError = () => {};
  sftp.on('error', ownError);
  sftp.once('close', () => {
    ended = true;
    sftp.off('error', ownError);
    drained.resolve();
  });
  const track = <T extends Readable | Writable>(stream: T): T => {
    streams.add(stream);
    void waitStreamClosed(stream).then(() => streams.delete(stream));
    // ssh2 can report a pending handle failure after a consumer has removed
    // its pipeline/iterator listener. Retain an owner-level listener so a
    // late stream error cannot terminate the Runtime process.
    stream.on('error', () => {});
    return stream;
  };
  const call = (
    method: 'mkdir' | 'rename' | 'replace' | 'unlink' | 'rmdir' | 'chmod',
    ...args: Array<string | number>
  ) =>
    new Promise<void>((resolve, reject) => {
      const callback = (error?: Error | null | undefined) => (error ? reject(error) : resolve());
      try {
        if (method === 'mkdir') sftp.mkdir(args[0] as string, callback);
        else if (method === 'rename') sftp.rename(args[0] as string, args[1] as string, callback);
        else if (method === 'replace')
          sftp.ext_openssh_rename(args[0] as string, args[1] as string, callback);
        else if (method === 'unlink') sftp.unlink(args[0] as string, callback);
        else if (method === 'rmdir') sftp.rmdir(args[0] as string, callback);
        else sftp.chmod(args[0] as string, args[1] as number, callback);
      } catch (error) {
        reject(
          method === 'replace' ? new RemoteFileCapabilityUnavailableError('atomic-replace') : error,
        );
      }
    });
  const stat = (method: 'stat' | 'lstat', path: string) =>
    new Promise<RemoteFileAttributes>((resolve, reject) => {
      sftp[method](path, (error, value) => (error ? reject(error) : resolve(attributes(value))));
    });
  return {
    realpath: (path) =>
      new Promise((resolve, reject) =>
        sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved))),
      ),
    list: async (path) => {
      const directory = await new Promise<Buffer>((resolve, reject) =>
        sftp.opendir(path, (error, handle) => (error ? reject(error) : resolve(handle))),
      );
      const entries: RemoteFilesystemEntry[] = [];
      let bytes = 0;
      let batches = 0;
      try {
        while (true) {
          if (++batches > 20_001)
            throw new ApplicationError(
              'CAPACITY_EXCEEDED',
              'SFTP directory batch limit exceeded',
              503,
            );
          const batch = await new Promise<FileEntryWithStats[] | null>((resolve, reject) =>
            sftp.readdir(directory, (error, value) => {
              if (error && (error as Error & { code?: number }).code === 1) resolve(null);
              else if (error) reject(error);
              else resolve(value);
            }),
          );
          if (batch === null) return entries;
          for (const entry of batch) {
            bytes += Buffer.byteLength(entry.filename) + 128;
            if (entries.length >= 20_000 || bytes > 64 * 1024 * 1024)
              throw new ApplicationError('CAPACITY_EXCEEDED', 'SFTP directory limit exceeded', 503);
            entries.push({ filename: entry.filename, attrs: attributes(entry.attrs) });
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          sftp.close(directory, (error) => (error ? reject(error) : resolve())),
        );
      }
    },
    stat: (path) => stat('stat', path),
    lstat: (path) => stat('lstat', path),
    mkdir: (path) => call('mkdir', path),
    rename: (from, to) => call('rename', from, to),
    replace: (from, to) => call('replace', from, to),
    unlink: (path) => call('unlink', path),
    rmdir: (path) => call('rmdir', path),
    chmod: (path, mode) => call('chmod', path, mode),
    readStream: (path, options) => track(sftpReadable(sftp, path, options)),
    writeStream: (path, options) => track(sftpWritable(sftp, path, options)),
    close: () => {
      closing ??= (async () => {
        const streamDrains = [...streams].map((stream) => {
          const drained = waitStreamClosed(stream);
          stream.destroy();
          return drained;
        });
        const timer = ended ? undefined : setTimeout(terminate, 1_000);
        try {
          sftp.end();
          await Promise.all([drained.promise, ...streamDrains]);
        } finally {
          clearTimeout(timer);
        }
      })();
      return closing;
    },
  };
}
