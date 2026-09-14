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
} from 'ssh2';
import type {
  SftpAttributes,
  SftpHandle,
  SshConnectionHandle,
  SshTransport,
} from '../../ports/ssh-transport';
import { SftpCapabilityUnavailableError } from '../../ports/ssh-transport';
import type { TerminalChannel } from '../../ports/terminal-channel';
import { connectLocalX11, resolveLocalX11, type ResolvedX11Forwarding } from './x11-forwarding';
import { createCertificateIdentity } from './certificate-identity';
import { probeSshAgent } from './ssh-agent';

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
    const certificateIdentity =
      input.certificate && input.privateKey
        ? createCertificateIdentity(input.privateKey, input.certificate, input.passphrase)
        : undefined;
    if (input.certificate && !certificateIdentity)
      throw new Error('SSH certificate requires a private key');
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
          .verifyHostKey({ algorithm: 'ssh', fingerprint, publicKey: key.toString('base64') })
          .then(verify, () => verify(false));
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
        .then(finish, () => finish([]));
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
        client.connect(config);
      });
    } catch (error) {
      client.destroy();
      throw error;
    } finally {
      client.off('keyboard-interactive', onKeyboardInteractive);
    }
    return new Ssh2ConnectionHandle(client);
  }
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

class Ssh2ConnectionHandle implements SshConnectionHandle {
  readonly id = randomUUID();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private closed = false;
  private closeError: Error | undefined;
  private readonly remoteHandlers = new Map<
    string,
    (...args: Parameters<Parameters<Client['on']>[1]>) => void
  >();
  private x11Forwarding: ManagedX11Forwarding | undefined;
  constructor(private readonly client: Client) {
    client.on('error', this.onClientError);
    client.once('close', this.onClientClose);
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
    return channelAsTerminal(channel, releaseX11);
  }

  async openSftp(): Promise<SftpHandle> {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((error, handle) => (error ? reject(error) : resolve(handle)));
    });
    return sftpHandle(sftp);
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
    return new Promise((resolve, reject) => {
      this.client.forwardOut(
        source.host,
        source.port,
        target.host,
        target.port,
        (error, channel) => (error ? reject(error) : resolve(channel)),
      );
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
        this.remoteHandlers.set(`${host}:${boundPort}`, handler as never);
        this.client.on('tcp connection', handler);
        resolve(boundPort);
      });
    });
  }

  unforwardIn(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) =>
      this.client.unforwardIn(host, port, (error) => {
        if (error) return reject(error);
        const handler = this.remoteHandlers.get(`${host}:${port}`);
        if (handler) this.client.off('tcp connection', handler as never);
        this.remoteHandlers.delete(`${host}:${port}`);
        resolve();
      }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.client.destroy();
        resolve();
      }, 1_000);
      this.client.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.client.end();
    });
  }

  private readonly onClientError = (error: Error) => {
    this.closeError = error;
  };

  private readonly onClientClose = () => {
    if (this.closed) return;
    this.closed = true;
    this.client.off('error', this.onClientError);
    for (const listener of this.closeListeners) listener(this.closeError);
    this.closeListeners.clear();
    for (const handler of this.remoteHandlers.values())
      this.client.off('tcp connection', handler as never);
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

function channelAsTerminal(channel: ClientChannel, onClose?: () => void): TerminalChannel {
  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  let exitCode: number | null = null;
  let closed = false;
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
    async close() {
      if (!closed) channel.close();
    },
  };
}

function attributes(stats: Stats): SftpAttributes {
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
function sftpHandle(sftp: SFTPWrapper): SftpHandle {
  const streams = new Set<Readable | Writable>();
  const track = <T extends Readable | Writable>(stream: T): T => {
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
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
        reject(method === 'replace' ? new SftpCapabilityUnavailableError('atomic-replace') : error);
      }
    });
  const stat = (method: 'stat' | 'lstat', path: string) =>
    new Promise<SftpAttributes>((resolve, reject) => {
      sftp[method](path, (error, value) => (error ? reject(error) : resolve(attributes(value))));
    });
  return {
    list: (path) =>
      new Promise((resolve, reject) =>
        sftp.readdir(path, (error, entries) =>
          error
            ? reject(error)
            : resolve(
                entries.map((entry) => ({
                  filename: entry.filename,
                  attrs: attributes(entry.attrs),
                })),
              ),
        ),
      ),
    stat: (path) => stat('stat', path),
    lstat: (path) => stat('lstat', path),
    mkdir: (path) => call('mkdir', path),
    rename: (from, to) => call('rename', from, to),
    replace: (from, to) => call('replace', from, to),
    unlink: (path) => call('unlink', path),
    rmdir: (path) => call('rmdir', path),
    chmod: (path, mode) => call('chmod', path, mode),
    readStream: (path, options) => track(sftp.createReadStream(path, options)),
    writeStream: (path, options) => track(sftp.createWriteStream(path, options)),
    close: async () => {
      await Promise.all(
        [...streams].map(
          (stream) =>
            new Promise<void>((resolve) => {
              if (stream.closed) return resolve();
              stream.once('close', resolve);
              if (!stream.destroyed) stream.destroy();
            }),
        ),
      );
      await new Promise<void>((resolve) => {
        sftp.once('end', resolve);
        sftp.end();
      });
    },
  };
}
