import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { RemoteDesktopProtocol } from '@axterm/plugin-api/remote-desktop';
import { getFtpTestSecureContext } from './ftp-test-certificate.ts';

/** Controlled TCP/TLS transport peer; rendering/native remote-server certification is separate. */
export async function remoteDesktopWire(protocol: RemoteDesktopProtocol) {
  const peers = new Set<Socket>();
  const context = protocol === 'rdp' ? await getFtpTestSecureContext() : undefined;
  const track = (socket: Socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
  };
  const server = createServer((raw) => {
    track(raw);
    if (protocol === 'rdp') {
      let header = Buffer.alloc(0);
      const first = (bytes: Buffer) => {
        header = Buffer.concat([header, bytes]);
        if (header.length > 65536) {
          raw.destroy();
          return;
        }
        if (header.length < 7) return;
        raw.off('data', first);
        if (header[0] !== 3 || header.readUInt16BE(2) !== 7) {
          raw.destroy();
          return;
        }
        raw.write(Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]), () => {
          const tls = new TLSSocket(raw, { isServer: true, secureContext: context });
          track(tls);
          tls.on('data', (data) => tls.write(data));
        });
      };
      raw.on('data', first);
    } else raw.on('data', (data) => raw.write(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return {
    port: address.port,
    peers,
    close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export function rdpFirstFrame(port: number): Buffer {
  const wrap = (tag: number, data: Buffer) =>
    Buffer.concat([Buffer.from([tag, data.length]), data]);
  return wrap(
    0x30,
    Buffer.concat([
      wrap(0xa0, wrap(0x02, Buffer.from([0x0d, 0x3e]))),
      wrap(0xa2, wrap(0x0c, Buffer.from(`127.0.0.1:${port}`))),
      wrap(0xa6, wrap(0x04, Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]))),
    ]),
  );
}
