import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import {
  Server as SshServer,
  utils,
  type AuthHandlerMiddleware,
  type Client,
  type ClientChannel,
  type ConnectConfig,
  type PseudoTtyOptions,
  type ShellOptions,
} from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import { SSH_COMPRESSION_ALGORITHMS, Ssh2Transport } from './ssh2-transport';

class FakeClient extends EventEmitter {
  config: ConnectConfig | undefined;
  destroyed = false;
  shellOptions: ShellOptions | undefined;
  shellChannel = new FakeChannel();

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
    const hostKey = utils.generateKeyPairSync('ed25519').private;
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
