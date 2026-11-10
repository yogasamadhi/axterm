import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type * as Ssh2 from 'ssh2';
import type { TunnelProfile } from '@axterm/plugin-api/connections';
import { Ssh2Transport } from '../../packages/plugins/connections/src/adapters/ssh2/ssh2-transport.ts';
import { NativeTunnels } from '../../packages/plugins/connections/src/adapters/tunnels.ts';
const ssh = createRequire(
  new URL('../../packages/plugins/connections/package.json', import.meta.url),
)('ssh2') as typeof Ssh2;
it('closes a real unread paused SSH forwarding channel without killing its parent connection', async () => {
  const peers = new Set<Ssh2.Connection>(),
    channels = new Set<Duplex>();
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => peers.delete(peer));
      peer.on('authentication', (ctx) => ctx.accept());
      peer.on('tcpip', (accept) => {
        const channel = accept();
        channel.on('error', () => {});
        channel.resume();
        channel.write(
          Buffer.concat([Buffer.from('SSH-2.0-unread-fixture\r\n'), Buffer.alloc(512 * 1024, 65)]),
        );
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No SSH listener');
  const handle = await new Ssh2Transport().connect({
    host: '127.0.0.1',
    port: address.port,
    username: 'fixture',
    connectionTimeoutMs: 2000,
    keepaliveIntervalMs: 0,
    keepaliveCountMax: 3,
    compression: false,
    algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
    verifyHostKey: async () => true,
    keyboardInteractive: async () => [],
  });
  let parentCloses = 0;
  const original = handle.forwardOut.bind(handle);
  vi.spyOn(handle, 'forwardOut').mockImplementation(async (...args) => {
    const channel = await original(...args);
    if (!(channel instanceof Duplex)) throw Error('Real SSH Duplex required');
    channels.add(channel);
    channel.once('close', () => channels.delete(channel));
    return channel;
  });
  const transport = new NativeTunnels(
    {
      handle: () => handle,
      close: async () => {
        parentCloses++;
        await handle.close();
      },
    },
    1000,
  );
  const now = new Date().toISOString(),
    profile: TunnelProfile = {
      id: randomUUID(),
      hostId: randomUUID(),
      name: 'Unread channel',
      type: 'local',
      bindHost: '127.0.0.1',
      bindPort: 0,
      targetHost: '127.0.0.1',
      targetPort: 22,
      allowNonLoopback: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  let socket: ReturnType<typeof createConnection> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lease = await transport.start(randomUUID(), profile, new AbortController().signal);
    socket = createConnection({ host: '127.0.0.1', port: lease.bindPort });
    socket.on('error', () => {});
    const closing = await new Promise<{ done: Promise<void> }>((resolve) =>
      socket!.once('data', () => {
        socket!.destroy();
        for (const channel of channels) channel.pause();
        resolve({ done: lease.close() });
      }),
    );
    await Promise.race([
      closing.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Actual SSH tunnel close did not drain unread data')),
          1500,
        );
      }),
    ]);
    clearTimeout(timer);
    expect(transport.resourceCount()).toBe(0);
    expect(channels.size).toBe(0);
    expect(parentCloses).toBe(0);
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    for (const channel of channels) channel.resume();
    await handle.close();
    for (const peer of peers) peer.end();
    await transport.close();
    await new Promise<void>((done) => server.close(() => done()));
    vi.restoreAllMocks();
  }
});
