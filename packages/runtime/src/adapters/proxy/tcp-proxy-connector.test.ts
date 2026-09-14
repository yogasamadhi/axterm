import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProxyEndpoint, ProxyConnectionError, TcpProxyConnector } from './tcp-proxy-connector';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('TcpProxyConnector', () => {
  it('opens an HTTP CONNECT tunnel and preserves bytes received after the response header', async () => {
    let request = '';
    const port = await listen((socket) => {
      sockets.push(socket);
      socket.once('data', (chunk) => {
        request = chunk.toString('latin1');
        socket.write('HTTP/1.1 200 Connection Established\r\nX-Test: yes\r\n\r\nserver-ready');
        socket.on('data', (data) => socket.write(data));
      });
    });

    const socket = await new TcpProxyConnector().connect({
      proxy: { url: `http://127.0.0.1:${port}` },
      target: { host: 'ssh.example.test', port: 22 },
      timeoutMs: 2_000,
    });
    sockets.push(socket as Socket);
    expect(request).toContain('CONNECT ssh.example.test:22 HTTP/1.1');
    expect(request).not.toContain('Proxy-Authorization');
    expect(await read(socket as Socket, 'server-ready'.length)).toBe('server-ready');
    socket.write('ping');
    expect(await read(socket as Socket, 4)).toBe('ping');
  });

  it('uses separate credentials for HTTP Basic proxy authentication', async () => {
    let authorization = '';
    const port = await listen((socket) => {
      sockets.push(socket);
      socket.once('data', (chunk) => {
        authorization =
          /^Proxy-Authorization: (.+)$/im.exec(chunk.toString('latin1'))?.[1]?.trim() ?? '';
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
      });
    });
    const socket = await new TcpProxyConnector().connect({
      proxy: { url: `http://127.0.0.1:${port}`, username: 'proxy-user', password: 's3cret' },
      target: { host: '127.0.0.1', port: 2222 },
      timeoutMs: 2_000,
    });
    sockets.push(socket as Socket);
    expect(authorization).toBe(`Basic ${Buffer.from('proxy-user:s3cret').toString('base64')}`);
  });

  it('performs a SOCKS5 username/password handshake and keeps the connected socket usable', async () => {
    const observed: { username?: string; password?: string; host?: string; port?: number } = {};
    const port = await listen((socket) => {
      sockets.push(socket);
      let stage = 0;
      socket.on('data', (chunk) => {
        if (stage === 0) {
          expect([...chunk]).toEqual([5, 2, 0, 2]);
          stage = 1;
          socket.write(Buffer.from([5, 2]));
          return;
        }
        if (stage === 1) {
          const usernameLength = chunk[1] ?? 0;
          const passwordLength = chunk[2 + usernameLength] ?? 0;
          observed.username = chunk.subarray(2, 2 + usernameLength).toString('utf8');
          observed.password = chunk
            .subarray(3 + usernameLength, 3 + usernameLength + passwordLength)
            .toString('utf8');
          stage = 2;
          socket.write(Buffer.from([1, 0]));
          return;
        }
        if (stage === 2) {
          expect([...chunk.subarray(0, 4)]).toEqual([5, 1, 0, 3]);
          const hostLength = chunk[4] ?? 0;
          observed.host = chunk.subarray(5, 5 + hostLength).toString('utf8');
          observed.port = chunk.readUInt16BE(5 + hostLength);
          stage = 3;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x1f, 0x90]));
          return;
        }
        socket.write(chunk);
      });
    });

    const socket = await new TcpProxyConnector().connect({
      proxy: { url: `socks5h://127.0.0.1:${port}`, username: 'alice', password: 'wonder' },
      target: { host: 'internal.example.test', port: 22 },
      timeoutMs: 2_000,
    });
    sockets.push(socket as Socket);
    expect(observed).toEqual({
      username: 'alice',
      password: 'wonder',
      host: 'internal.example.test',
      port: 22,
    });
    socket.write('ok');
    expect(await read(socket as Socket, 2)).toBe('ok');
  });

  it('encodes an IPv6 target with the SOCKS5 IPv6 address type', async () => {
    let resolveRequest!: (value: Buffer) => void;
    const observedRequest = new Promise<Buffer>((resolve) => {
      resolveRequest = resolve;
    });
    const port = await listen((socket) => {
      sockets.push(socket);
      let buffer = Buffer.alloc(0);
      let stage = 0;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0 && buffer.length >= 3) {
          buffer = buffer.subarray(3);
          stage = 1;
          socket.write(Buffer.from([5, 0]));
        }
        if (stage === 1 && buffer.length >= 22) {
          resolveRequest(buffer.subarray(0, 22));
          buffer = buffer.subarray(22);
          stage = 2;
          socket.write(Buffer.from([5, 0, 0, 4, ...Array(16).fill(0), 0, 22]));
        }
      });
    });

    const socket = await new TcpProxyConnector().connect({
      proxy: { url: `socks5://127.0.0.1:${port}` },
      target: { host: '2001:db8::1', port: 22 },
      timeoutMs: 2_000,
    });
    sockets.push(socket as Socket);
    expect([...(await observedRequest)]).toEqual([
      5, 1, 0, 4, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 22,
    ]);
  });

  it('maps HTTP authentication rejection and canceled handshakes to typed errors', async () => {
    const rejectPort = await listen((socket) => {
      sockets.push(socket);
      socket.once('data', () => socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'));
    });
    await expect(
      new TcpProxyConnector().connect({
        proxy: { url: `http://127.0.0.1:${rejectPort}` },
        target: { host: 'example.test', port: 22 },
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'PROXY_AUTH_REQUIRED' });

    const hangingPort = await listen((socket) => sockets.push(socket));
    const controller = new AbortController();
    const pending = new TcpProxyConnector().connect({
      proxy: { url: `socks5://127.0.0.1:${hangingPort}` },
      target: { host: 'example.test', port: 22 },
      timeoutMs: 2_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'PROXY_ABORTED' });
  });

  it('bounds a stalled handshake and closes the accepted socket', async () => {
    let accepted: Socket | undefined;
    let resolveAcceptedClosed!: () => void;
    const acceptedClosed = new Promise<void>((resolve) => {
      resolveAcceptedClosed = resolve;
    });
    const port = await listen((socket) => {
      accepted = socket;
      sockets.push(socket);
      socket.once('close', resolveAcceptedClosed);
      socket.resume();
    });
    await expect(
      new TcpProxyConnector().connect({
        proxy: { url: `http://127.0.0.1:${port}` },
        target: { host: 'example.test', port: 22 },
        timeoutMs: 250,
      }),
    ).rejects.toMatchObject({ code: 'PROXY_TIMEOUT' });
    await Promise.race([
      acceptedClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Proxy fixture socket was not closed')), 1_000),
      ),
    ]);
    expect(accepted?.destroyed).toBe(true);
  });

  it('rejects oversized HTTP responses without retaining an unbounded buffer', async () => {
    const port = await listen((socket) => {
      sockets.push(socket);
      socket.once('data', () => socket.write(Buffer.alloc(33 * 1024, 65)));
    });
    await expect(
      new TcpProxyConnector().connect({
        proxy: { url: `http://127.0.0.1:${port}` },
        target: { host: 'example.test', port: 22 },
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({ code: 'PROXY_RESPONSE_TOO_LARGE' });
  });
});

describe('parseProxyEndpoint', () => {
  it('applies protocol defaults and never accepts credentials inside the URL', () => {
    expect(parseProxyEndpoint({ url: 'http://proxy.example.test' })).toMatchObject({ port: 8080 });
    expect(parseProxyEndpoint({ url: 'https://proxy.example.test' })).toMatchObject({ port: 443 });
    expect(parseProxyEndpoint({ url: 'socks5://proxy.example.test' })).toMatchObject({
      port: 1080,
    });
    expect(parseProxyEndpoint({ url: 'http://[::1]:3128' })).toMatchObject({
      host: '::1',
      port: 3128,
    });
    expect(() => parseProxyEndpoint({ url: 'http://alice:secret@proxy.example.test' })).toThrow(
      ProxyConnectionError,
    );
    expect(() =>
      parseProxyEndpoint({ url: 'http://proxy.example.test', username: 'alice' }),
    ).toThrowError(/together/);
    expect(() => parseProxyEndpoint({ url: 'ftp://proxy.example.test' })).toThrowError(/must use/);
  });
});

async function listen(handler: (socket: Socket) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server has no port');
  return address.port;
}

function read(socket: Socket, bytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', rejectWithCleanup);
    };
    const rejectWithCleanup = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length < bytes) return;
      cleanup();
      const value = Buffer.concat(chunks, length);
      const remainder = value.subarray(bytes);
      if (remainder.length) socket.unshift(remainder);
      resolve(value.subarray(0, bytes).toString('utf8'));
    };
    socket.on('data', onData);
    socket.once('error', rejectWithCleanup);
  });
}
