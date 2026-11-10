import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
/** Independent bounded RFB 3.8 peer with a real framebuffer and input decoding. */
export async function vncFrameWire() {
  const peers = new Set<Socket>(),
    pointers: Array<{ buttons: number; x: number; y: number }> = [],
    keys: number[] = [],
    clipboard: string[] = [];
  let completed = 0;
  const stats: { types: number[]; reason: string; stages: number[] } = {
    types: [],
    reason: '',
    stages: [],
  };
  const server = createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    let buffer = Buffer.alloc(0),
      stage = 0,
      sentFrame = false,
      redShift = 16,
      bigEndian = false;
    socket.write('RFB 003.008\n');
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) {
        socket.destroy();
        return;
      }
      for (;;) {
        if (stage === 0) {
          if (buffer.length < 12) return;
          if (buffer.subarray(0, 12).toString() !== 'RFB 003.008\n') {
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(12);
          socket.write(Buffer.from([1, 1]));
          stage = 1;
        } else if (stage === 1) {
          if (buffer.length < 1) return;
          if (buffer[0] !== 1) {
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(1);
          socket.write(Buffer.alloc(4));
          stage = 2;
        } else if (stage === 2) {
          if (buffer.length < 1) return;
          buffer = buffer.subarray(1);
          const name = Buffer.from('Owned VNC fixture'),
            init = Buffer.alloc(24);
          init.writeUInt16BE(64, 0);
          init.writeUInt16BE(48, 2);
          init[4] = 32;
          init[5] = 24;
          init[7] = 1;
          for (const at of [8, 10, 12]) init.writeUInt16BE(255, at);
          init[14] = 16;
          init[15] = 8;
          init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name]));
          stage = 3;
          completed++;
        } else {
          if (!buffer.length) return;
          const type = buffer[0];
          stats.types.push(type!);
          let length: number;
          if (type === 0) length = 20;
          else if (type === 2) {
            if (buffer.length < 4) return;
            length = 4 + 4 * buffer.readUInt16BE(2);
          } else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) {
            if (buffer.length < 8) return;
            length = 8 + buffer.readUInt32BE(4);
          } else if (type === 150) length = 10;
          else if (type === 248) length = 9;
          else {
            socket.destroy();
            return;
          }
          if (length > 65536) {
            socket.destroy();
            return;
          }
          if (buffer.length < length) return;
          const request = buffer.subarray(0, length);
          buffer = buffer.subarray(length);
          if (type === 3 && !sentFrame) {
            sentFrame = true;
            const header = Buffer.alloc(16);
            header.writeUInt16BE(1, 2);
            header.writeUInt16BE(64, 8);
            header.writeUInt16BE(48, 10);
            const pixels = Buffer.alloc(64 * 48 * 4);
            for (let at = 0; at < pixels.length; at += 4) {
              const value = (255 << redShift) >>> 0;
              if (bigEndian) pixels.writeUInt32BE(value, at);
              else pixels.writeUInt32LE(value, at);
            }
            socket.write(Buffer.concat([header, pixels]));
          } else if (type === 0) {
            if (request[4] !== 32 || request[14]! > 24) {
              socket.destroy();
              return;
            }
            redShift = request[14]!;
            bigEndian = request[6] !== 0;
          } else if (type === 5)
            pointers.push({
              buttons: request[1]!,
              x: request.readUInt16BE(2),
              y: request.readUInt16BE(4),
            });
          else if (type === 4) keys.push(request.readUInt32BE(4));
          else if (type === 6) clipboard.push(request.subarray(8).toString('utf8'));
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('VNC_FIXTURE_UNBOUND');
  return {
    port: address.port,
    peers,
    pointers,
    keys,
    clipboard,
    completed: () => completed,
    stats,
    close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
