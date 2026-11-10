import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import type { FileInfo } from 'basic-ftp';
import iconv from 'iconv-lite';
import { startFtpFixture } from '../fixtures/ftp-wire.ts';
import { RemoteFileCapabilityUnavailableError } from '@axterm/plugin-api/host';
import { RemoteFileService } from '../../packages/plugins/files/src/application/remote-file-service.ts';
import {
  BasicFtpAdapter,
  FTP_MAX_LISTING_BYTES,
  type BasicFtpClient,
} from '../../packages/plugins/connections/src/adapters/ftp/basic-ftp-adapter.ts';

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
        RemoteFileCapabilityUnavailableError,
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
      const service = new RemoteFileService({
        openFiles: async () => {
          const filesystem = await transport.connect({
            host: '127.0.0.1',
            port: fixture.port,
            username: 'operator',
            security: 'plain',
            tlsVerify: true,
            encoding: 'utf-8',
            timeoutMs: 3000,
          });
          return {
            filesystem,
            signal: new AbortController().signal,
            close: () => filesystem.close(),
          };
        },
      });
      const target = { protocol: 'ftp' as const, connectionId: randomUUID() };
      const opened = await service.readText(target, '/hello.txt');
      await expect(
        service.writeText(target, {
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

it('waits for actual control/data closure even when the vendor removes its socket listeners', async () => {
  const controlled = Promise.withResolvers<void>();
  const dataClosed = Promise.withResolvers<void>();
  const control = new PassThrough({
    destroy(_error, done) {
      void controlled.promise.then(() => done());
    },
  });
  const data = new PassThrough({
    destroy(_error, done) {
      void dataClosed.promise.then(() => done());
    },
  });
  const { client } = clientFixture();
  Object.assign(client.ftp, { socket: control, dataSocket: data });
  client.close = vi.fn(() => {
    control.removeAllListeners();
    data.removeAllListeners();
    control.destroy();
    data.destroy();
  });
  const handle = await new BasicFtpAdapter(() => client).connect({
    host: 'fixture',
    port: 21,
    username: 'fixture',
    security: 'plain',
    tlsVerify: true,
    encoding: 'utf-8',
    timeoutMs: 1000,
  });
  const released = vi.fn();
  const closing = handle.close();
  expect(handle.close()).toBe(closing);
  void closing.then(released);
  controlled.resolve();
  await Promise.resolve();
  expect(released).not.toHaveBeenCalled();
  dataClosed.resolve();
  await closing;
  expect(released).toHaveBeenCalledOnce();
  expect(control.closed && data.closed).toBe(true);
});

it.each(['bytes', 'entries'] as const)(
  'bounds real FTP listing %s before publishing directory metadata',
  async (kind) => {
    const listing =
      kind === 'bytes'
        ? 'x'.repeat(FTP_MAX_LISTING_BYTES + 1)
        : 'type=file;size=0;modify=20260913000000; item\r\n'.repeat(20_003);
    const fixture = await startFtpFixture({ listing });
    const handle = await new BasicFtpAdapter().connect({
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      security: 'plain',
      tlsVerify: true,
      encoding: 'utf-8',
      timeoutMs: 3000,
    });
    try {
      await expect(handle.list('/')).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    } finally {
      await handle.close();
      await fixture.close();
    }
  },
);

it.each(['explicit-tls', 'implicit-tls'] as const)(
  'uses real %s control/data TLS and rejects an untrusted certificate by default',
  async (security) => {
    const fixture = await startFtpFixture({
      security,
      username: 'operator',
      password: 'fixture-password',
    });
    const adapter = new BasicFtpAdapter();
    const input = {
      host: '127.0.0.1',
      port: fixture.port,
      username: 'operator',
      password: 'fixture-password',
      security,
      encoding: 'utf-8' as const,
      timeoutMs: 3000,
    };
    try {
      await expect(adapter.connect({ ...input, tlsVerify: true })).rejects.toThrow(
        /self-signed certificate/i,
      );
      const handle = await adapter.connect({ ...input, tlsVerify: false });
      try {
        expect(await handle.list('/')).toMatchObject([{ filename: 'hello.txt' }]);
        await pipeline(Readable.from('TLS protected upload'), handle.writeStream('/tls.txt'));
        const chunks: Buffer[] = [];
        for await (const chunk of handle.readStream('/tls.txt')) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe('TLS protected upload');
      } finally {
        await handle.close();
      }
    } finally {
      await fixture.close();
    }
  },
);

it('does not overwrite an existing FTP create target, applies requested modes and joins early upload failures under backpressure', async () => {
  const { client, uploads } = clientFixture();
  const handle = await new BasicFtpAdapter(() => client).connect({
    host: '127.0.0.1',
    port: 21,
    username: 'operator',
    security: 'plain',
    tlsVerify: true,
    encoding: 'utf-8',
    timeoutMs: 1000,
  });
  try {
    await expect(
      pipeline(
        Readable.from('replacement'),
        handle.writeStream('/' + iconv.encode('测试.txt', 'gbk').toString('latin1'), {
          flags: 'wx',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(client.uploadFrom).not.toHaveBeenCalled();
    await pipeline(
      Readable.from('new bytes'),
      handle.writeStream('/new.txt', { flags: 'wx', mode: 0o640 }),
    );
    expect(uploads.get('/new.txt')?.toString()).toBe('new bytes');
    expect(client.send).toHaveBeenCalledWith('SITE CHMOD 640 /new.txt');
    client.uploadFrom = vi.fn(async () => {
      throw new Error('550 upload refused');
    });
    await expect(
      pipeline(Readable.from(Buffer.alloc(256 * 1024)), handle.writeStream('/failed.bin')),
    ).rejects.toThrow('550 upload refused');
  } finally {
    await handle.close();
  }
});

it('returns an inclusive bounded FTP read range and closes its data/control sockets', async () => {
  const fixture = await startFtpFixture();
  const handle = await new BasicFtpAdapter().connect({
    host: '127.0.0.1',
    port: fixture.port,
    username: 'operator',
    security: 'plain',
    tlsVerify: true,
    encoding: 'utf-8',
    timeoutMs: 3000,
  });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of handle.readStream('/hello.txt', { start: 1, end: 3 }))
      chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('ell');
  } finally {
    await handle.close();
    await fixture.close();
  }
});
