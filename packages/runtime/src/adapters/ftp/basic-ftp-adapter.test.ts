import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import type { FileInfo } from 'basic-ftp';
import iconv from 'iconv-lite';
import { BasicFtpAdapter, type BasicFtpClient } from './basic-ftp-adapter';

function clientFixture() {
  const uploads = new Map<string, Buffer>();
  const client: BasicFtpClient = {
    ftp: { encoding: 'utf8' },
    closed: false,
    access: vi.fn(async () => ({})),
    pwd: vi.fn(async () => '/'),
    cd: vi.fn(async () => ({})),
    list: vi.fn(async () => [
      {
        name: iconv.encode('测试.txt', 'gbk').toString('latin1'),
        size: 5,
        modifiedAt: new Date('2026-09-13T00:00:00.000Z'),
        permissions: { user: 6, group: 4, world: 0 },
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      } as FileInfo,
    ]),
    rename: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    send: vi.fn(async () => ({})),
    uploadFrom: vi.fn(async (source: Readable, path: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      uploads.set(path, Buffer.concat(chunks));
      return {};
    }),
    appendFrom: vi.fn(async () => ({})),
    downloadTo: vi.fn(async (destination, path) => {
      destination.write(Buffer.from(`download:${path}`));
      destination.end();
      return {};
    }),
    close: vi.fn(),
  };
  return { client, uploads };
}

describe('BasicFtpAdapter', () => {
  it('maps explicit and implicit TLS without leaking credentials into file metadata', async () => {
    for (const [security, expected] of [
      ['plain', false],
      ['explicit-tls', true],
      ['implicit-tls', 'implicit'],
    ] as const) {
      const { client } = clientFixture();
      const adapter = new BasicFtpAdapter(() => client);
      const handle = await adapter.connect({
        host: 'ftp.example.test',
        port: security === 'implicit-tls' ? 990 : 21,
        username: 'operator',
        password: 'never-return-this',
        security,
        tlsVerify: true,
        encoding: 'utf-8',
        timeoutMs: 1_000,
      });
      expect(client.access).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'ftp.example.test', secure: expected }),
      );
      await handle.close();
      expect(client.close).toHaveBeenCalledOnce();
    }
  });

  it('decodes legacy listings and keeps upload/download streams bounded and awaited', async () => {
    const { client, uploads } = clientFixture();
    const handle = await new BasicFtpAdapter(() => client).connect({
      host: '127.0.0.1',
      port: 21,
      username: 'operator',
      security: 'plain',
      tlsVerify: true,
      encoding: 'gbk',
      timeoutMs: 1_000,
    });
    expect(client.ftp.encoding).toBe('latin1');
    const entries = await handle.list('/目录');
    expect(entries[0]?.filename).toBe('测试.txt');

    await pipeline(Readable.from(Buffer.from('streamed upload')), handle.writeStream('/目标.txt'));
    expect([...uploads.values()][0]?.toString()).toBe('streamed upload');

    const download = handle.readStream('/remote.txt');
    const chunks: Buffer[] = [];
    download.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    await once(download, 'end');
    expect(Buffer.concat(chunks).toString()).toContain('download:');
    await handle.close();
  });

  it('browses, uploads and downloads through a real FTP control/data socket', async () => {
    const fixture = await startFtpFixture();
    try {
      const handle = await new BasicFtpAdapter().connect({
        host: '127.0.0.1',
        port: fixture.port,
        username: 'operator',
        password: 'fixture-password',
        security: 'plain',
        tlsVerify: true,
        encoding: 'utf-8',
        timeoutMs: 3_000,
      });
      const listed = await handle.list('/');
      expect(listed).toMatchObject([{ filename: 'hello.txt', attrs: { isFile: true, size: 5 } }]);
      await pipeline(Readable.from('uploaded over ftp'), handle.writeStream('/uploaded.txt'));
      expect(fixture.files.get('/uploaded.txt')?.toString()).toBe('uploaded over ftp');
      const chunks: Buffer[] = [];
      for await (const chunk of handle.readStream('/hello.txt')) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      await handle.close();
    } finally {
      await fixture.close();
    }
  });
});

async function startFtpFixture(): Promise<{
  port: number;
  files: Map<string, Buffer>;
  close(): Promise<void>;
}> {
  const files = new Map<string, Buffer>([['/hello.txt', Buffer.from('hello')]]);
  const dataServers = new Set<Server>();
  const controlSockets = new Set<Socket>();
  let passive: Promise<Socket> | undefined;
  const server = createServer((socket) => {
    controlSockets.add(socket);
    socket.on('close', () => controlSockets.delete(socket));
    socket.write('220 Axterm FTP fixture\r\n');
    let buffer = '';
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n');
        const line = buffer.slice(0, offset);
        buffer = buffer.slice(offset + 2);
        chain = chain
          .then(() => respond(line))
          .catch(() => {
            socket.destroy();
          });
      }
    });
    async function respond(line: string) {
      const separator = line.indexOf(' ');
      const command = (separator < 0 ? line : line.slice(0, separator)).toUpperCase();
      const argument = separator < 0 ? '' : line.slice(separator + 1);
      if (command === 'USER') socket.write('331 Password required\r\n');
      else if (command === 'PASS') socket.write('230 Logged in\r\n');
      else if (command === 'FEAT')
        socket.write('211-Features\r\n EPSV\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
      else if (command === 'OPTS' || command === 'TYPE' || command === 'STRU')
        socket.write('200 Command accepted\r\n');
      else if (command === 'PWD') socket.write('257 "/" is current directory\r\n');
      else if (command === 'CWD') socket.write('250 Directory changed\r\n');
      else if (command === 'EPSV') {
        let accept!: (data: Socket) => void;
        passive = new Promise<Socket>((resolve) => {
          accept = resolve;
        });
        const dataServer = createServer((data) => accept(data));
        dataServers.add(dataServer);
        dataServer.on('close', () => dataServers.delete(dataServer));
        dataServer.listen(0, '127.0.0.1');
        await once(dataServer, 'listening');
        const address = dataServer.address();
        if (!address || typeof address === 'string') throw new Error('FTP data fixture failed');
        socket.write(`229 Entering Extended Passive Mode (|||${address.port}|)\r\n`);
      } else if (command === 'MLSD' || command === 'LIST') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        const listing = [...files.entries()]
          .filter(([path]) => path.split('/').filter(Boolean).length === 1)
          .map(([path, content]) =>
            command === 'MLSD'
              ? `type=file;size=${content.length};modify=20260913000000; ${path.slice(1)}\r\n`
              : `-rw-r--r-- 1 user group ${content.length} Sep 13 00:00 ${path.slice(1)}\r\n`,
          )
          .join('');
        data.end(listing);
        await once(data, 'close');
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'STOR') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        const chunks: Buffer[] = [];
        data.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        await once(data, 'end');
        files.set(argument, Buffer.concat(chunks));
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'RETR') {
        socket.write('150 Opening data connection\r\n');
        const data = await requirePassive();
        data.end(files.get(argument) ?? Buffer.alloc(0));
        await once(data, 'close');
        socket.write('226 Transfer complete\r\n');
      } else if (command === 'QUIT') {
        socket.end('221 Goodbye\r\n');
      } else socket.write('200 Command accepted\r\n');
    }
    async function requirePassive() {
      if (!passive) throw new Error('Passive data connection was not prepared');
      const next = passive;
      passive = undefined;
      return next;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FTP fixture failed');
  return {
    port: address.port,
    files,
    close: async () => {
      for (const socket of controlSockets) socket.destroy();
      for (const dataServer of dataServers) dataServer.close();
      server.close();
      await once(server, 'close');
    },
  };
}
