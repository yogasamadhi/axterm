import { once } from 'node:events';
import process from 'node:process';
import { Server as SshServer, utils, type Connection } from 'ssh2';
import type { TerminalChannel } from '../../../ports/terminal-channel';
import { NodePtyAdapter } from '../../pty/node-pty-adapter';
import { Ssh2Transport } from '../../ssh2/ssh2-transport';

export interface SshPtyFixture {
  channel: TerminalChannel;
  close(): Promise<void>;
}

/** A real encrypted loopback SSH shell with a separate Node PTY peer. */
export async function openSshPtyFixture(input: {
  root: string;
  fixture: string;
  file: string;
  direction: 'send' | 'receive';
}): Promise<SshPtyFixture> {
  const peers = new Set<TerminalChannel>();
  const connections = new Set<Connection>();
  // ssh2@1.17.0 intermittently emits Ed25519 keys its own parser rejects.
  // This fixture exercises encrypted SSH/PTy transfer, not host-key algorithms.
  const server = new SshServer(
    { hostKeys: [utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (connection) => {
      connections.add(connection);
      connection.once('close', () => connections.delete(connection));
      connection.on('authentication', (context) => {
        if (context.method === 'none') context.accept();
        else context.reject(['none']);
      });
      connection.on('ready', () => {
        connection.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty?.());
          session.on('shell', (acceptShell) => {
            const stream = acceptShell();
            const peer = new NodePtyAdapter().open({
              shell: process.execPath,
              args: [input.fixture, input.file, input.direction],
              cwd: input.root,
              env: {},
              term: 'xterm-256color',
              loginShell: false,
              cols: 80,
              rows: 24,
            });
            peers.add(peer);
            peer.onData((data) => stream.write(Buffer.from(data)));
            peer.onExit((code) => {
              peers.delete(peer);
              if (!stream.destroyed) {
                stream.exit(code ?? 1);
                stream.end();
              }
            });
            stream.on('data', (data: Buffer) => peer.write(data));
            stream.once('close', () => void peer.close());
          });
        });
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SSH test server did not bind');
  let handle: Awaited<ReturnType<Ssh2Transport['connect']>> | undefined;
  let channel: TerminalChannel | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channel?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    for (const peer of peers) await peer.close().catch(() => undefined);
    for (const connection of connections) connection.end();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };
  try {
    handle = await new Ssh2Transport().connect({
      host: '127.0.0.1',
      port: address.port,
      username: 'operator',
      connectionTimeoutMs: 10_000,
      keepaliveIntervalMs: 0,
      keepaliveCountMax: 0,
      compression: false,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      verifyHostKey: async () => true,
      keyboardInteractive: async () => [],
    });
    channel = await handle.openShell({ cols: 80, rows: 24, term: 'xterm-256color', env: {} });
    return { channel, close };
  } catch (error) {
    await close();
    throw error;
  }
}
