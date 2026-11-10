import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';

/** Test-owned prompt/login TCP peer; protocol negotiation has separate real-wire adapter coverage. */
export async function startTelnetFixture(username: string, password: string) {
  const peers = new Set<Socket>();
  let authentications = 0;
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    let phase = 0;
    let pending = '';
    socket.write('login: ');
    socket.on('data', (bytes) => {
      if (phase === 2) {
        if (socket.writableLength > 1024 * 1024) {
          socket.destroy();
          return;
        }
        if (!socket.write(bytes)) {
          socket.pause();
          socket.once('drain', () => socket.resume());
        }
        return;
      }
      pending += bytes.toString();
      if (pending.length > 4096) {
        socket.destroy();
        return;
      }
      const end = pending.indexOf('\r\n');
      if (end < 0) return;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (phase === 0 && line === username) {
        phase = 1;
        socket.write('Password: ');
      } else if (phase === 1 && line === password) {
        phase = 2;
        authentications++;
        socket.write('TELNET_AUTHENTICATED\r\n');
      } else socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Telnet fixture did not bind');
  return {
    port: address.port,
    peers,
    authentications: () => authentications,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
