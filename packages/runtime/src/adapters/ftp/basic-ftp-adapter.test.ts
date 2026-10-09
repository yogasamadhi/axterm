import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import type { FileInfo } from 'basic-ftp';
import iconv from 'iconv-lite';
import { SftpCapabilityUnavailableError } from '../../ports/ssh-transport';
import { SftpService } from '../../application/sftp-service';
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
    expect(client.close).not.toHaveBeenCalled();

    const download = handle.readStream('/remote.txt');
    const chunks: Buffer[] = [];
    download.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    await once(download, 'end');
    expect(Buffer.concat(chunks).toString()).toContain('download:');
    expect(client.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('closes a pending FTP data channel when a caller cancels a read or write stream', async () => {
    async function connect(client: BasicFtpClient) {
      return new BasicFtpAdapter(() => client).connect({
        host: '127.0.0.1',
        port: 21,
        username: 'operator',
        security: 'plain',
        tlsVerify: true,
        encoding: 'utf-8',
        timeoutMs: 1_000,
      });
    }

    const readFixture = clientFixture();
    let rejectRead!: (error: Error) => void;
    readFixture.client.downloadTo = vi.fn(async (destination) => {
      destination.write(Buffer.from('first download bytes'));
      await new Promise<never>((_, reject) => {
        rejectRead = reject;
      });
    });
    readFixture.client.close = vi.fn(() => rejectRead(new Error('download canceled')));
    const readHandle = await connect(readFixture.client);
    const read = readHandle.readStream('/slow-download.bin');
    read.resume();
    await vi.waitFor(() => expect(readFixture.client.downloadTo).toHaveBeenCalledOnce());
    read.destroy();
    await vi.waitFor(() => expect(readFixture.client.close).toHaveBeenCalledOnce());
    await readHandle.close();

    const writeFixture = clientFixture();
    let rejectWrite!: (error: Error) => void;
    writeFixture.client.uploadFrom = vi.fn(
      async () =>
        new Promise<never>((_, reject) => {
          rejectWrite = reject;
        }),
    );
    writeFixture.client.close = vi.fn(() => rejectWrite(new Error('upload canceled')));
    const writeHandle = await connect(writeFixture.client);
    const write = writeHandle.writeStream('/slow-upload.bin');
    write.write(Buffer.from('first upload bytes'));
    await vi.waitFor(() => expect(writeFixture.client.uploadFrom).toHaveBeenCalledOnce());
    write.destroy();
    await vi.waitFor(() => expect(writeFixture.client.close).toHaveBeenCalledOnce());
    await writeHandle.close();
  });

  it('rejects FTP command-control characters before they reach a client operation', async () => {
    const { client } = clientFixture();
    const handle = await new BasicFtpAdapter(() => client).connect({
      host: '127.0.0.1',
      port: 21,
      username: 'operator',
      security: 'plain',
      tlsVerify: true,
      encoding: 'utf-8',
      timeoutMs: 1_000,
    });
    const unsafe = '/report\r\nDELE another-user-file';

    await expect(handle.cd(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.realpath(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.list(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.lstat(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.mkdir(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.rename('/safe-source', unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.replace('/safe-source', unsafe)).rejects.toThrow(
      'FTP paths cannot contain',
    );
    await expect(handle.unlink(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.rmdir(unsafe)).rejects.toThrow('FTP paths cannot contain');
    await expect(handle.chmod(unsafe, 0o600)).rejects.toThrow('FTP paths cannot contain');
    expect(() => handle.readStream(unsafe)).toThrow('FTP paths cannot contain');
    expect(() => handle.writeStream(unsafe)).toThrow('FTP paths cannot contain');
    expect(client.cd).not.toHaveBeenCalled();
    expect(client.list).not.toHaveBeenCalled();
    expect(client.rename).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(client.downloadTo).not.toHaveBeenCalled();
    expect(client.uploadFrom).not.toHaveBeenCalled();

    await handle.close();
  });

  it('does not delete an existing target when an FTP replacement rename is refused', async () => {
    const { client } = clientFixture();
    client.rename = vi.fn(async () => {
      throw new Error('550 target cannot be replaced');
    });
    const handle = await new BasicFtpAdapter(() => client).connect({
      host: '127.0.0.1',
      port: 21,
      username: 'operator',
      security: 'plain',
      tlsVerify: true,
      encoding: 'utf-8',
      timeoutMs: 1_000,
    });

    await expect(handle.replace('/.axterm-stage.tmp', '/existing.txt')).rejects.toThrow(
      '550 target cannot be replaced',
    );
    expect(client.rename).toHaveBeenCalledOnce();
    expect(client.rename).toHaveBeenCalledWith('/.axterm-stage.tmp', '/existing.txt');
    expect(client.remove).not.toHaveBeenCalled();
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

  it('keeps the original bytes when a real FTP server refuses rename-overwrite', async () => {
    const fixture = await startFtpFixture();
    try {
      const handle = await new BasicFtpAdapter().connect({
        host: '127.0.0.1',
        port: fixture.port,
        username: 'operator',
        security: 'plain',
        tlsVerify: true,
        encoding: 'utf-8',
        timeoutMs: 3_000,
      });
      await pipeline(Readable.from('replacement'), handle.writeStream('/.axterm-stage.tmp'));
      await expect(handle.replace('/.axterm-stage.tmp', '/hello.txt')).rejects.toBeInstanceOf(
        SftpCapabilityUnavailableError,
      );
      expect(fixture.files.get('/hello.txt')?.toString()).toBe('hello');
      expect(fixture.files.get('/.axterm-stage.tmp')?.toString()).toBe('replacement');
      await handle.unlink('/.axterm-stage.tmp');
      expect(fixture.files.has('/.axterm-stage.tmp')).toBe(false);
      await handle.close();
    } finally {
      await fixture.close();
    }
  });

  it('preserves the original and cleans the stage through the real text-save service', async () => {
    const fixture = await startFtpFixture();
    try {
      const transport = new BasicFtpAdapter();
      const service = new SftpService({
        handle: () => ({
          openSftp: () =>
            transport.connect({
              host: '127.0.0.1',
              port: fixture.port,
              username: 'operator',
              security: 'plain',
              tlsVerify: true,
              encoding: 'utf-8',
              timeoutMs: 3_000,
            }),
        }),
      } as never);
      const opened = await service.readText('ftp-fixture', '/hello.txt');
      await expect(
        service.writeText('ftp-fixture', {
          path: '/hello.txt',
          content: 'new text',
          overwriteRevision: opened.revision,
          lineEnding: 'lf',
        }),
      ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      expect(fixture.files.get('/hello.txt')?.toString()).toBe('hello');
      expect([...fixture.files.keys()].filter((path) => path.endsWith('.tmp'))).toEqual([]);
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
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The real client may close immediately after QUIT, before this fixture's
      // reply is flushed. Keep that expected disconnect from escaping Vitest.
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error;
    });
    socket.write('220 Axterm FTP fixture\r\n');
    let buffer = '';
    let chain = Promise.resolve();
    let renameFrom: string | null = null;
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
      } else if (command === 'RNFR') {
        if (!files.has(argument)) socket.write('550 Source not found\r\n');
        else {
          renameFrom = argument;
          socket.write('350 Ready for RNTO\r\n');
        }
      } else if (command === 'RNTO') {
        const source = renameFrom;
        renameFrom = null;
        if (!source) socket.write('503 Use RNFR first\r\n');
        else if (files.has(argument)) socket.write('550 Target exists\r\n');
        else {
          files.set(argument, files.get(source)!);
          files.delete(source);
          socket.write('250 Rename complete\r\n');
        }
      } else if (command === 'DELE') {
        if (!files.delete(argument)) socket.write('550 File not found\r\n');
        else socket.write('250 Deleted\r\n');
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
