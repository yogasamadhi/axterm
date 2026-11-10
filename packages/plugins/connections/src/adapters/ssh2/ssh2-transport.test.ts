import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import {
  Server as SshServer,
  utils,
  type AuthHandlerMiddleware,
  type Client,
  type ClientChannel,
  type ClientSFTPCallback,
  type ConnectConfig,
  type PseudoTtyOptions,
  type SFTPWrapper,
  type ShellOptions,
} from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { SSH_COMPRESSION_ALGORITHMS, Ssh2Transport } from './ssh2-transport.ts';

class FakeClient extends EventEmitter {
  config: ConnectConfig | undefined;
  destroyed = false;
  shellOptions: ShellOptions | undefined;
  shellChannel = new FakeChannel();
  sftpChannel = new EventEmitter();
  sftpEnd = vi.fn(() => {
    this.sftpChannel.emit('end');
    this.sftpChannel.emit('close');
  });

  connect(config: ConnectConfig) {
    this.config = config;
    queueMicrotask(() => this.emit('ready'));
    return this;
  }

  end() {
    this.emit('close');
    return this;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  shell(
    _window: PseudoTtyOptions,
    options: ShellOptions,
    callback: (error: Error | undefined, channel: ClientChannel) => void,
  ) {
    this.shellOptions = options;
    queueMicrotask(() => callback(undefined, this.shellChannel as unknown as ClientChannel));
    return this;
  }

  sftp(callback: ClientSFTPCallback) {
    queueMicrotask(() =>
      callback(
        undefined,
        Object.assign(this.sftpChannel, { end: this.sftpEnd }) as unknown as SFTPWrapper,
      ),
    );
    return this;
  }
}

class FakeChannel extends PassThrough {
  stderr = new PassThrough();
  setWindow() {}
  signal() {}
  close() {
    this.emit('close');
    return this;
  }
}

function input(overrides: Partial<Parameters<Ssh2Transport['connect']>[0]> = {}) {
  return {
    host: 'ssh.example.test',
    port: 22,
    username: 'operator',
    connectionTimeoutMs: 42_000,
    keepaliveIntervalMs: 12_000,
    keepaliveCountMax: 7,
    compression: true,
    algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
    verifyHostKey: async () => true,
    keyboardInteractive: async () => [],
    ...overrides,
  };
}

describe('Ssh2Transport connection options', () => {
  it('dispatches remote forwarded channels to exactly one address owner and rejects unknown destinations', async () => {
    const client = Object.assign(new FakeClient(), {
      forwardIn: (
        _host: string,
        port: number,
        callback: (error: Error | undefined, bound: number) => void,
      ) => {
        callback(undefined, port);
      },
      unforwardIn: (_host: string, _port: number, callback: (error?: Error) => void) => {
        callback();
      },
    });
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const first = vi.fn();
    const second = vi.fn();
    await handle.forwardIn('127.0.0.1', 23456, first);
    await handle.forwardIn('127.0.0.2', 23456, second);
    expect(client.listenerCount('tcp connection')).toBe(1);
    const channel = new FakeChannel();
    const accept = vi.fn(() => channel as unknown as ClientChannel);
    const reject = vi.fn();
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 30000, destIP: '127.0.0.2', destPort: 23456 },
      accept,
      reject,
    );
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 30001, destIP: '127.0.0.3', destPort: 23456 },
      accept,
      reject,
    );
    expect(reject).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    await handle.unforwardIn('127.0.0.2', 23456);
    client.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 30002, destIP: '127.0.0.2', destPort: 23456 },
      accept,
      reject,
    );
    expect(reject).toHaveBeenCalledTimes(2);
    await handle.close();
    channel.destroy();
    expect(client.listenerCount('tcp connection')).toBe(0);
  });

  it('revokes the connection when a server assigns a forwarding address already owned by another lease', async () => {
    const client = Object.assign(new FakeClient(), {
      forwardIn: (
        _host: string,
        port: number,
        callback: (error: Error | undefined, bound: number) => void,
      ) => {
        callback(undefined, port);
      },
    });
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    await handle.forwardIn('127.0.0.1', 23456, () => {});
    await expect(handle.forwardIn('127.0.0.1', 23456, () => {})).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(client.listenerCount('tcp connection')).toBe(0);
    await handle.close();
  });

  it('cleans up synchronous private-key parse failures without exposing parser text', async () => {
    const client = new FakeClient();
    const controller = new AbortController();
    client.connect = () => {
      throw new Error('Cannot parse privateKey: secret-value');
    };
    const error = await new Ssh2Transport(() => client as unknown as Client)
      .connect(input({ signal: controller.signal }))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'SSH_KEY_INVALID' });
    expect((error as Error).message).not.toContain('secret-value');
    expect(client.destroyed).toBe(true);
    expect(client.listenerCount('ready')).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('keyboard-interactive')).toBe(0);
  });

  it.each([
    [{ code: 'ECONNREFUSED' }, 'SSH_CONNECTION_REFUSED'],
    [{ code: 'ETIMEDOUT' }, 'SSH_CONNECTION_TIMEOUT'],
    [{ level: 'client-timeout' }, 'SSH_CONNECTION_TIMEOUT'],
    [{ code: 'ENOTFOUND' }, 'SSH_DNS_FAILED'],
    [{ code: 'EAI_AGAIN' }, 'SSH_DNS_FAILED'],
    [{ code: 'EHOSTUNREACH' }, 'SSH_NETWORK_UNREACHABLE'],
    [{ code: 'ECONNRESET' }, 'SSH_CONNECTION_LOST'],
    [{ level: 'client-authentication' }, 'AUTHENTICATION_FAILED'],
    [{ level: 'handshake' }, 'SSH_NEGOTIATION_FAILED'],
    [{}, 'SSH_CONNECTION_FAILED'],
  ])(
    'classifies connection failures without returning vendor messages: %j',
    async (details, code) => {
      const client = new FakeClient();
      client.connect = () => {
        queueMicrotask(() =>
          client.emit('error', Object.assign(new Error('password=secret-value'), details)),
        );
        return client;
      };
      const error = await new Ssh2Transport(() => client as unknown as Client)
        .connect(input())
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain('secret-value');
      expect(client.destroyed).toBe(true);
      expect(client.listenerCount('ready')).toBe(0);
      expect(client.listenerCount('error')).toBe(0);
      expect(client.listenerCount('keyboard-interactive')).toBe(0);
    },
  );

  it.each(['end', 'close'])('closes an SFTP channel after a prior %s event once', async (event) => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const sftp = await handle.openSftp();
    client.sftpChannel.emit(event);
    await Promise.all([sftp.close(), sftp.close()]);
    await sftp.close();
    expect(client.sftpEnd).toHaveBeenCalledTimes(1);
    expect(client.sftpChannel.listenerCount('end')).toBe(0);
    expect(client.sftpChannel.listenerCount('close')).toBe(0);
    await handle.close();
  });

  it('joins simultaneous SFTP closes and releases both completion listeners', async () => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const sftp = await handle.openSftp();
    await Promise.all([sftp.close(), sftp.close()]);
    await sftp.close();
    expect(client.sftpEnd).toHaveBeenCalledTimes(1);
    expect(client.sftpChannel.listenerCount('end')).toBe(0);
    expect(client.sftpChannel.listenerCount('close')).toBe(0);
    await handle.close();
  });

  it('waits for physical SFTP close after end and joins termination without an acknowledgement', async () => {
    const client = new FakeClient();
    client.sftpEnd = vi.fn(() => {
      client.sftpChannel.emit('end');
    });
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const sftp = await handle.openSftp();
    const released = vi.fn();
    vi.useFakeTimers();
    try {
      const closing = sftp.close().then(released);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.destroyed).toBe(true);
      expect(released).not.toHaveBeenCalled();
      client.sftpChannel.emit('close');
      await closing;
      expect(released).toHaveBeenCalledOnce();
      expect(client.sftpChannel.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
      await handle.close();
    }
  });

  it('does not release the SSH transport when destruction has only been requested', async () => {
    const client = new FakeClient();
    client.end = () => client;
    client.destroy = () => {
      client.destroyed = true;
      return client;
    };
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const released = vi.fn();
    vi.useFakeTimers();
    try {
      const closing = handle.close();
      expect(handle.close()).toBe(closing);
      void closing.then(released);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.destroyed).toBe(true);
      expect(released).not.toHaveBeenCalled();
      client.emit('close');
      await closing;
      expect(released).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a terminal channel close and terminates its owner after a missing acknowledgement', async () => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    client.shellChannel.close = () => client.shellChannel;
    const terminal = await handle.openShell({ cols: 80, rows: 24, term: 'xterm', env: {} });
    const released = vi.fn();
    vi.useFakeTimers();
    try {
      const closing = terminal.close().then(released);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.destroyed).toBe(true);
      expect(released).not.toHaveBeenCalled();
      client.shellChannel.emit('close');
      await closing;
      expect(released).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await handle.close();
    }
  });

  it('reads directory protocol batches and closes the directory handle on the capacity boundary', async () => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const directory = Buffer.from('directory');
    const attrs = {
      size: 0,
      mode: 0o100600,
      atime: 0,
      mtime: 0,
      uid: 0,
      gid: 0,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    };
    const opendir = vi.fn((_path: string, callback: (error: undefined, handle: Buffer) => void) =>
      callback(undefined, directory),
    );
    const readdir = vi.fn(
      (
        received: Buffer,
        callback: (
          error: undefined,
          entries: Array<{ filename: string; attrs: typeof attrs }>,
        ) => void,
      ) => {
        expect(received).toBe(directory);
        callback(
          undefined,
          Array.from({ length: 1000 }, (_, index) => ({ filename: String(index), attrs })),
        );
      },
    );
    const close = vi.fn((_received: Buffer, callback: () => void) => callback());
    Object.assign(client.sftpChannel, { opendir, readdir, close });
    const sftp = await handle.openSftp();
    await expect(sftp.list('/huge')).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(readdir).toHaveBeenCalledTimes(21);
    expect(close).toHaveBeenCalledOnce();
    await sftp.close();
    await handle.close();
  });

  it('cancels a stalled SFTP subsystem open by terminating its owner and still waits for the native callback', async () => {
    const client = new FakeClient();
    let reply: ClientSFTPCallback | undefined;
    client.sftp = (callback) => {
      reply = callback;
      return client;
    };
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const controller = new AbortController();
    const released = vi.fn();
    vi.useFakeTimers();
    try {
      const opening = handle.openSftp(controller.signal);
      const failed = expect(opening).rejects.toThrow('closed');
      void opening.then(released, () => {});
      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.destroyed).toBe(true);
      expect(released).not.toHaveBeenCalled();
      reply!(new Error('closed'), undefined as never);
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      await handle.close();
    }
  });

  it('maps bounded SSH options into ssh2 and reports post-ready disconnects', async () => {
    const client = new FakeClient();
    const transport = new Ssh2Transport(() => client as unknown as Client);
    const handle = await transport.connect(input());

    expect(client.config).toMatchObject({
      host: 'ssh.example.test',
      port: 22,
      username: 'operator',
      readyTimeout: 42_000,
      keepaliveInterval: 12_000,
      keepaliveCountMax: 7,
      algorithms: { compress: [...SSH_COMPRESSION_ALGORITHMS] },
    });
    expect(client.listenerCount('ready')).toBe(0);
    expect(client.listenerCount('keyboard-interactive')).toBe(0);

    const disconnected = vi.fn();
    handle.onClose(disconnected);
    const failure = new Error('network lost');
    client.emit('error', failure);
    client.emit('close');
    expect(disconnected).toHaveBeenCalledWith(failure);
    expect(client.listenerCount('error')).toBe(0);
    await handle.close();
  });

  it('reports the public-key algorithm encoded in the SSH host-key blob', async () => {
    const client = new FakeClient();
    const verifyHostKey = vi.fn(async () => true);
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(
      input({ verifyHostKey }),
    );
    const hostKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private;
    const parsed = utils.parseKey(hostKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
    const verify = vi.fn();
    const hostVerifier = client.config?.hostVerifier as
      ((key: Buffer, callback: (valid: boolean) => void) => void) | undefined;
    hostVerifier?.(parsed.getPublicSSH(), verify);
    await Promise.resolve();
    await Promise.resolve();
    expect(verify).toHaveBeenCalledWith(true);
    expect(verifyHostKey).toHaveBeenCalledWith(
      expect.objectContaining({ algorithm: 'ecdsa-sha2-nistp256' }),
    );
    await handle.close();
  });

  it('disables compression explicitly and removes connect listeners when aborted', async () => {
    const disabledClient = new FakeClient();
    const disabled = new Ssh2Transport(() => disabledClient as unknown as Client);
    const handle = await disabled.connect(input({ compression: false }));
    expect(disabledClient.config?.algorithms?.compress).toEqual(['none']);
    await handle.close();

    const pendingClient = new FakeClient();
    pendingClient.connect = function (config: ConnectConfig) {
      this.config = config;
      return this;
    };
    const controller = new AbortController();
    const pending = new Ssh2Transport(() => pendingClient as unknown as Client).connect(
      input({ signal: controller.signal }),
    );
    controller.abort(new Error('closed by owner'));
    await expect(pending).rejects.toThrow('closed by owner');
    expect(pendingClient.destroyed).toBe(true);
    expect(pendingClient.listenerCount('ready')).toBe(0);
    expect(pendingClient.listenerCount('error')).toBe(0);
  });

  it('passes explicit algorithm order to ssh2 without replacing unspecified defaults', async () => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(
      input({
        algorithms: {
          kex: ['curve25519-sha256', 'diffie-hellman-group14-sha256'],
          cipher: ['aes256-ctr'],
          serverHostKey: ['ssh-ed25519'],
          hmac: ['hmac-sha2-256-etm@openssh.com'],
        },
      }),
    );
    expect(client.config?.algorithms).toEqual({
      kex: ['curve25519-sha256', 'diffie-hellman-group14-sha256'],
      cipher: ['aes256-ctr'],
      serverHostKey: ['ssh-ed25519'],
      hmac: ['hmac-sha2-256-etm@openssh.com'],
      compress: [...SSH_COMPRESSION_ALGORITHMS],
    });
    await handle.close();
  });

  it('restarts the configured authentication order after partial success', async () => {
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(
      input({ password: 'password', agent: '/tmp/agent.sock' }),
    );
    const authHandler = client.config?.authHandler as AuthHandlerMiddleware;
    const next = vi.fn();
    authHandler([], false, next);
    authHandler(['password', 'keyboard-interactive'], false, next);
    authHandler(['keyboard-interactive'], true, next);
    authHandler(['keyboard-interactive'], true, next);
    expect(next.mock.calls.map(([method]) => method)).toEqual([
      'none',
      'password',
      'keyboard-interactive',
      'keyboard-interactive',
    ]);
    await handle.close();
  });

  it('completes consecutive keyboard-interactive challenges over a real SSH protocol', async () => {
    // `ssh2` parses its generated Ed25519 key in OpenSSH format, which is
    // intermittent under the Node runtime used by the test workers. This
    // fixture exercises keyboard-interactive auth rather than Ed25519 itself,
    // so use ssh2's stable ECDSA PEM output for its temporary host key.
    const hostKey = utils.generateKeyPairSync('ecdsa', { bits: 256 }).private;
    let challenge = 0;
    const server = new SshServer({ hostKeys: [hostKey] }, (connection) => {
      connection.on('authentication', (context) => {
        if (context.method === 'none') return context.reject(['keyboard-interactive']);
        if (context.method !== 'keyboard-interactive')
          return context.reject(['keyboard-interactive']);
        challenge += 1;
        const passwordStep = challenge === 1;
        context.prompt(
          [{ prompt: passwordStep ? 'Password: ' : 'OTP: ', echo: false }],
          passwordStep ? 'Password verification' : 'Second factor',
          '',
          (answers) => {
            if (passwordStep && answers[0] === 'password')
              context.reject(['keyboard-interactive'], true);
            else if (!passwordStep && answers[0] === '654321') context.accept();
            else context.reject(['keyboard-interactive']);
          },
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SSH fixture did not bind');
    const prompts: string[] = [];
    let handle;
    try {
      handle = await new Ssh2Transport().connect(
        input({
          host: '127.0.0.1',
          port: address.port,
          keyboardInteractive: async ({ prompts: requested }) => {
            prompts.push(requested[0]?.prompt ?? '');
            return [prompts.length === 1 ? 'password' : '654321'];
          },
        }),
      );
      expect(prompts).toEqual(['Password: ', 'OTP: ']);
      expect(challenge).toBe(2);
    } finally {
      await handle?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects stalled forward opens on connection close and destroys a late callback channel', async () => {
    const client = new FakeClient();
    let callback: ((error: Error | undefined, channel: ClientChannel) => void) | undefined;
    Object.assign(client, {
      forwardOut: (
        _source: string,
        _sourcePort: number,
        _target: string,
        _port: number,
        done: typeof callback,
      ) => {
        callback = done;
      },
    });
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    const opening = handle.forwardOut(
      { host: '127.0.0.1', port: 0 },
      { host: '127.0.0.1', port: 22 },
    );
    const rejected = expect(opening).rejects.toThrow('SSH_FORWARD_CONNECTION_CLOSED');
    await handle.close();
    await rejected;
    const late = new FakeChannel();
    callback!(undefined, late as unknown as ClientChannel);
    expect(late.destroyed).toBe(true);
    await expect(
      handle.forwardOut({ host: '127.0.0.1', port: 0 }, { host: '127.0.0.1', port: 22 }),
    ).rejects.toThrow('SSH_FORWARD_CONNECTION_CLOSED');
  });

  it('owns one X11 listener and releases forwarded sockets with the terminal', async () => {
    const { display, server } = await listenOnAvailableDisplay();
    const client = new FakeClient();
    const handle = await new Ssh2Transport(() => client as unknown as Client).connect(input());
    try {
      const terminal = await handle.openShell({
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
        env: {},
        x11: { display: `localhost:${display}.2` },
      });
      expect(client.shellOptions?.x11).toMatchObject({ screen: 2 });
      expect(client.listenerCount('x11')).toBe(1);

      const remote = new FakeChannel();
      const accept = vi.fn(() => remote as unknown as ClientChannel);
      const reject = vi.fn();
      client.emit('x11', { srcIP: '127.0.0.1', srcPort: 4000 }, accept, reject);
      await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
      expect(reject).not.toHaveBeenCalled();

      await terminal.close();
      expect(client.listenerCount('x11')).toBe(0);
      expect(remote.destroyed).toBe(true);
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});

async function listenOnAvailableDisplay() {
  for (let display = 40; display < 70; display += 1) {
    const server = createServer();
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(6_000 + display, '127.0.0.1', () => resolve(true));
    });
    if (listening) return { display, server };
    server.close();
  }
  throw new Error('No test X11 display port is available');
}
