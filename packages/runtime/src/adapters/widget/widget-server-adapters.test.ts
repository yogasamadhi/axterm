import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { EOL, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { type FtpStagingWriteStreamFactory, NodeLocalFtpServer } from './node-local-ftp-server';
import { NodeLocalSshServer } from './node-local-ssh-server';
import { Ssh2Transport } from '../ssh2/ssh2-transport';

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];

class PartialFailureWritable extends Writable {
  private readonly handle: Promise<FileHandle>;
  private written = 0;

  constructor(
    path: string,
    options: { flags: 'a' | 'wx'; mode: number },
    private readonly failure: Error,
    private readonly recordWrite: (bytes: number) => void,
  ) {
    super();
    this.handle = open(path, options.flags, options.mode);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    void this.writeUntilFailure(bytes).then(() => callback(), callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.handle
      .then((handle) => handle.close())
      .then(
        () => callback(error),
        (closeError: Error) => callback(error ?? closeError),
      );
  }

  private async writeUntilFailure(bytes: Buffer): Promise<void> {
    const remaining = 64 - this.written;
    if (remaining > 0) {
      const requested = Math.min(bytes.byteLength, remaining);
      const { bytesWritten } = await (await this.handle).write(bytes, 0, requested);
      this.written += bytesWritten;
      this.recordWrite(bytesWritten);
    }
    if (this.written >= 64) throw this.failure;
  }
}

function partialFailureFactory(
  failingFlags: 'a' | 'wx',
  failure: Error,
  recordWrite: (bytes: number) => void,
): FtpStagingWriteStreamFactory {
  return (path, options) =>
    options.flags === failingFlags
      ? new PartialFailureWritable(path, options, failure, recordWrite)
      : createWriteStream(path, options);
}

async function openFtpControl(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  const [greeting] = (await once(socket, 'data')) as [Buffer];
  expect(greeting.toString('utf8')).toContain('220 Axterm FTP ready');
  return socket;
}

function ftpReplyReader(socket: Socket): { next(): Promise<string>; close(): void } {
  let buffered = Buffer.alloc(0);
  let failure: Error | undefined;
  const replies: string[] = [];
  const waiters: Array<{ resolve: (reply: string) => void; reject: (error: Error) => void }> = [];
  const flush = () => {
    while (replies.length > 0 && waiters.length > 0) {
      const reply = replies.shift()!;
      waiters.shift()!.resolve(reply);
    }
    if (!failure) return;
    while (waiters.length > 0) waiters.shift()!.reject(failure);
  };
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    let delimiter = buffered.indexOf('\r\n');
    while (delimiter >= 0) {
      replies.push(buffered.subarray(0, delimiter).toString('utf8'));
      buffered = buffered.subarray(delimiter + 2);
      delimiter = buffered.indexOf('\r\n');
    }
    flush();
  };
  const onError = (error: Error) => {
    failure = error;
    flush();
  };
  const onClose = () => {
    failure ??= new Error('FTP control connection closed before a reply');
    flush();
  };
  socket.on('data', onData);
  socket.once('error', onError);
  socket.once('close', onClose);
  return {
    next: () => {
      const reply = replies.shift();
      if (reply !== undefined) return Promise.resolve(reply);
      if (failure) return Promise.reject(failure);
      return new Promise<string>((resolveReply, rejectReply) => {
        waiters.push({ resolve: resolveReply, reject: rejectReply });
      });
    },
    close: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      failure ??= new Error('FTP control reply reader closed');
      flush();
    },
  };
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(
      () => rejectResult(new Error(`Protocol test ${label} timed out`)),
      5_000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveResult(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectResult(error);
      },
    );
  });
}

async function runCurl(args: string[]): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    const append = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) {
        child.kill();
        rejectRun(new Error('System curl output exceeded test bound'));
      } else {
        stdout.push(chunk);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout: Buffer.concat(stdout) }));
  });
}

afterEach(async () => {
  await Promise.allSettled(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local server Widget adapters', () => {
  it('starts repeated ephemeral SSH servers with parseable host keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-keys-'));
    roots.push(root);
    for (let index = 0; index < 128; index += 1) {
      const server = await new NodeLocalSshServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        username: 'tester',
        password: 'widget-password',
      });
      await server.stop();
    }
  });

  it('runs an authenticated FTP server with a bounded passive range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-widget-'));
    const outside = await mkdtemp(join(tmpdir(), 'axterm-ftp-widget-outside-'));
    roots.push(root);
    roots.push(outside);
    await writeFile(join(root, 'ftp.txt'), 'ftp-widget');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'escape'));
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'ftpuser',
      password: 'widget-password',
      passivePortStart: 50_320,
      passivePortEnd: 50_327,
    });
    stops.push(server.stop);
    const denied = new FtpClient(5_000);
    await expect(
      denied.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'ftpuser',
        password: 'wrong-password',
      }),
    ).rejects.toThrow();
    denied.close();

    const client = new FtpClient(5_000);
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'ftpuser',
      password: 'widget-password',
    });
    const passive = await client.send('PASV');
    const values = passive.message.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    expect(values?.slice(1, 5).join('.')).toBe('127.0.0.1');
    const passivePort = Number(values?.[5]) * 256 + Number(values?.[6]);
    expect(passivePort).toBeGreaterThanOrEqual(50_320);
    expect(passivePort).toBeLessThanOrEqual(50_327);
    expect((await client.list()).map(({ name }) => name)).toContain('ftp.txt');
    await expect(client.cd('escape')).rejects.toThrow();
    await client.uploadFrom(Readable.from(Buffer.from('uploaded')), 'uploaded.txt');
    expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('uploaded');
    await client.uploadFrom(Readable.from(Buffer.from('replacement')), 'replacement-stage.txt');
    await client.rename('/replacement-stage.txt', '/ftp.txt');
    expect(await readFile(join(root, 'ftp.txt'), 'utf8')).toBe('replacement');
    await expect(readFile(join(root, 'replacement-stage.txt'), 'utf8')).rejects.toThrow();
    await symlink('ftp.txt', join(root, 'file-link'));
    await client.uploadFrom(Readable.from(Buffer.from('must-not-follow-link')), 'link-stage.txt');
    await expect(client.rename('/link-stage.txt', '/file-link')).rejects.toThrow();
    expect(await readFile(join(root, 'ftp.txt'), 'utf8')).toBe('replacement');
    expect(await readFile(join(root, 'link-stage.txt'), 'utf8')).toBe('must-not-follow-link');
    await client.remove('/link-stage.txt');
    await client.downloadTo(join(outside, 'downloaded.txt'), 'ftp.txt');
    await expect(
      client.uploadFrom(Readable.from(Buffer.from('denied')), 'escape/bad.txt'),
    ).rejects.toThrow();
    await client.ensureDir('new-dir');
    await client.rename('/uploaded.txt', '/new-dir/renamed.txt');
    expect((await client.list('/new-dir')).map(({ name }) => name)).toContain('renamed.txt');
    await client.remove('/new-dir/renamed.txt');
    await client.removeDir('/new-dir');
    await client.cd('/');
    await expect(client.send('PORT 1,2,3,4,7,138')).rejects.toThrow();
    const activeChunks: Buffer[] = [];
    let finishActive!: () => void;
    let activeReceived = new Promise<void>((resolveData) => {
      finishActive = resolveData;
    });
    const activeListener = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => activeChunks.push(chunk));
      socket.once('end', finishActive);
    });
    await new Promise<void>((resolveListen) =>
      activeListener.listen(0, '127.0.0.1', resolveListen),
    );
    const activeAddress = activeListener.address();
    expect(activeAddress && typeof activeAddress !== 'string').toBe(true);
    const activePort = typeof activeAddress === 'string' || !activeAddress ? 0 : activeAddress.port;
    await client.send(`PORT 127,0,0,1,${activePort >> 8},${activePort & 255}`);
    await client.send('LIST');
    await activeReceived;
    await new Promise<void>((resolveClose) => activeListener.close(() => resolveClose()));
    expect(Buffer.concat(activeChunks).toString('utf8')).toContain('ftp.txt');
    activeChunks.length = 0;
    activeReceived = new Promise<void>((resolveData) => {
      finishActive = resolveData;
    });
    await new Promise<void>((resolveListen) =>
      activeListener.listen(0, '127.0.0.1', resolveListen),
    );
    const extendedAddress = activeListener.address();
    const extendedPort =
      typeof extendedAddress === 'string' || !extendedAddress ? 0 : extendedAddress.port;
    await client.send(`EPRT |1|127.0.0.1|${extendedPort}|`);
    await client.send('NLST');
    await activeReceived;
    await new Promise<void>((resolveClose) => activeListener.close(() => resolveClose()));
    expect(Buffer.concat(activeChunks).toString('utf8')).toContain('ftp.txt');
    client.close();
    expect(await readFile(join(outside, 'downloaded.txt'), 'utf8')).toBe('replacement');
    await expect(readFile(join(outside, 'bad.txt'), 'utf8')).rejects.toThrow();
  });

  it('keeps FTP control alive during an active data transfer and restores the idle timeout afterward', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-long-transfer-'));
    roots.push(root);
    const server = await new NodeLocalFtpServer(undefined, undefined, undefined, 150).start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_650,
      passivePortEnd: 50_657,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    let data: Socket | undefined;
    try {
      control.write('USER tester\r\n');
      expect(await withDeadline(replies.next(), 'long-transfer USER reply')).toMatch(/^331 /u);
      control.write('PASS widget-password\r\n');
      expect(await withDeadline(replies.next(), 'long-transfer PASS reply')).toMatch(/^230 /u);
      control.write('TYPE I\r\n');
      expect(await withDeadline(replies.next(), 'long-transfer TYPE reply')).toMatch(/^200 /u);
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), 'long-transfer PASV reply');
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      if (!values) throw new Error('FTP passive reply has no data address');
      const port = Number(values[5]) * 256 + Number(values[6]);
      data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      await withDeadline(once(data, 'connect'), 'long-transfer data connect');
      control.write('STOR slow.bin\r\n');
      expect(await withDeadline(replies.next(), 'long-transfer STOR opening reply')).toMatch(
        /^150 /u,
      );
      data.write('first-');
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      data.end('second');
      expect(await withDeadline(replies.next(), 'long-transfer STOR completion reply')).toMatch(
        /^226 /u,
      );
      expect(await readFile(join(root, 'slow.bin'), 'utf8')).toBe('first-second');
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'long-transfer NOOP reply')).toMatch(/^200 /u);
      await withDeadline(once(control, 'close'), 'restored FTP control idle timeout');
    } finally {
      data?.destroy();
      replies.close();
      control.destroy();
    }
  });

  it('keeps FTP control alive while a slow download is streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-slow-download-'));
    roots.push(root);
    await writeFile(join(root, 'slow.bin'), 'first-second');
    const slowReadFile = async (path: string, flags: number): Promise<FileHandle> => {
      const file = await open(path, flags);
      return new Proxy(file, {
        get(target, property) {
          if (property === 'createReadStream')
            return () =>
              Readable.from(
                (async function* () {
                  yield Buffer.from('first-');
                  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
                  yield Buffer.from('second');
                })(),
              );
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const server = await new NodeLocalFtpServer(undefined, undefined, slowReadFile, 150).start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_658,
      passivePortEnd: 50_665,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    let data: Socket | undefined;
    try {
      control.write('USER tester\r\n');
      expect(await withDeadline(replies.next(), 'slow-download USER reply')).toMatch(/^331 /u);
      control.write('PASS widget-password\r\n');
      expect(await withDeadline(replies.next(), 'slow-download PASS reply')).toMatch(/^230 /u);
      control.write('TYPE I\r\n');
      expect(await withDeadline(replies.next(), 'slow-download TYPE reply')).toMatch(/^200 /u);
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), 'slow-download PASV reply');
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      if (!values) throw new Error('FTP passive reply has no data address');
      const port = Number(values[5]) * 256 + Number(values[6]);
      data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      const received: Buffer[] = [];
      data.on('data', (chunk: Buffer) => received.push(chunk));
      await withDeadline(once(data, 'connect'), 'slow-download data connect');
      const ended = once(data, 'end');
      control.write('RETR slow.bin\r\n');
      expect(await withDeadline(replies.next(), 'slow-download RETR opening reply')).toMatch(
        /^150 /u,
      );
      await withDeadline(ended, 'slow-download data end');
      expect(Buffer.concat(received).toString('utf8')).toBe('first-second');
      expect(await withDeadline(replies.next(), 'slow-download RETR completion reply')).toMatch(
        /^226 /u,
      );
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'slow-download NOOP reply')).toMatch(/^200 /u);
      await withDeadline(once(control, 'close'), 'restored slow-download control timeout');
    } finally {
      data?.destroy();
      replies.close();
      control.destroy();
    }
  });

  it('times out a stalled active upload, cleans staging and keeps the control session usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-active-stall-'));
    roots.push(root);
    await writeFile(join(root, 'existing.bin'), 'original');
    const server = await new NodeLocalFtpServer(undefined, undefined, undefined, 1_000, 300).start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_666,
      passivePortEnd: 50_673,
    });
    stops.push(server.stop);
    const activeListener = createServer();
    await new Promise<void>((resolveListen) =>
      activeListener.listen(0, '127.0.0.1', resolveListen),
    );
    const address = activeListener.address();
    if (!address || typeof address === 'string')
      throw new Error('Active FTP listener did not bind');
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    let data: Socket | undefined;
    try {
      control.write('USER tester\r\n');
      expect(await withDeadline(replies.next(), 'active-stall USER reply')).toMatch(/^331 /u);
      control.write('PASS widget-password\r\n');
      expect(await withDeadline(replies.next(), 'active-stall PASS reply')).toMatch(/^230 /u);
      control.write('TYPE I\r\n');
      expect(await withDeadline(replies.next(), 'active-stall TYPE reply')).toMatch(/^200 /u);
      control.write(`PORT 127,0,0,1,${address.port >> 8},${address.port & 255}\r\n`);
      expect(await withDeadline(replies.next(), 'active-stall PORT reply')).toMatch(/^200 /u);
      const connected = once(activeListener, 'connection') as Promise<[Socket]>;
      control.write('STOR existing.bin\r\n');
      expect(await withDeadline(replies.next(), 'active-stall STOR opening reply')).toMatch(
        /^150 /u,
      );
      [data] = await withDeadline(connected, 'active-stall data connect');
      data.on('error', () => undefined);
      data.write('partial');
      let stagedBytesObserved = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const stagingName = (await readdir(root)).find((name) => name.endsWith('.part'));
        if (stagingName && (await stat(join(root, stagingName))).size > 0) {
          stagedBytesObserved = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(stagedBytesObserved).toBe(true);
      expect(await withDeadline(replies.next(), 'active-stall timeout reply')).toMatch(/^426 /u);
      expect(await readFile(join(root, 'existing.bin'), 'utf8')).toBe('original');
      expect(await readdir(root)).toEqual(['existing.bin']);
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'active-stall recovery NOOP')).toMatch(/^200 /u);
    } finally {
      data?.destroy();
      replies.close();
      control.destroy();
      await new Promise<void>((resolveClose) => activeListener.close(() => resolveClose()));
    }
  });

  it('rejects destructive FTP commands on symlinks inside the granted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-link-mutation-'));
    roots.push(root);
    await writeFile(join(root, 'protected.txt'), 'keep-file');
    await mkdir(join(root, 'protected-dir'));
    await symlink('protected.txt', join(root, 'file-link'));
    await symlink('protected-dir', join(root, 'dir-link'));
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_360,
      passivePortEnd: 50_367,
    });
    stops.push(server.stop);
    const client = new FtpClient(5_000);
    try {
      await client.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'tester',
        password: 'widget-password',
      });
      await expect(client.send('DELE file-link')).rejects.toThrow();
      expect(await readFile(join(root, 'protected.txt'), 'utf8')).toBe('keep-file');
      expect(await readFile(join(root, 'file-link'), 'utf8')).toBe('keep-file');

      await expect(client.send('RMD dir-link')).rejects.toThrow();
      expect(await readdir(join(root, 'protected-dir'))).toEqual([]);
      expect(await readdir(join(root, 'dir-link'))).toEqual([]);

      await expect(client.send('RNFR file-link')).rejects.toThrow();
      await expect(client.send('RNTO renamed.txt')).rejects.toThrow();
      expect(await readFile(join(root, 'protected.txt'), 'utf8')).toBe('keep-file');
      await expect(readFile(join(root, 'renamed.txt'))).rejects.toThrow();
      expect((await client.send('NOOP')).code).toBe(200);
    } finally {
      client.close();
    }
  });

  it('does not disclose a read opened through a transient outside-root ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-read-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'axterm-ftp-read-race-outside-'));
    roots.push(root, outside);
    const branch = join(root, 'branch');
    const displaced = join(root, 'branch-held');
    await mkdir(branch);
    await writeFile(join(branch, 'payload.txt'), 'inside');
    await writeFile(join(outside, 'payload.txt'), 'OUTSIDE-SECRET-CONTENTS');
    let swaps = 0;
    const openedHandles: FileHandle[] = [];
    const readOpener = async (path: string, flags: number): Promise<FileHandle> => {
      await rename(branch, displaced);
      try {
        await symlink(outside, branch);
        const handle = await open(path, flags);
        openedHandles.push(handle);
        swaps += 1;
        return handle;
      } finally {
        await unlink(branch).catch(() => undefined);
        await rename(displaced, branch);
      }
    };
    const server = await new NodeLocalFtpServer(undefined, undefined, readOpener).start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'ftpuser',
      password: 'widget-password',
      passivePortStart: 50_560,
      passivePortEnd: 50_567,
    });
    stops.push(server.stop);
    const client = new FtpClient(5_000);
    try {
      await client.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'ftpuser',
        password: 'widget-password',
      });
      await expect(client.size('branch/payload.txt')).rejects.toThrow();
      await expect(client.send('MDTM branch/payload.txt')).rejects.toThrow();
      const received: Buffer[] = [];
      const sink = new PassThrough();
      sink.on('data', (bytes: Buffer) => received.push(bytes));
      await expect(client.downloadTo(sink, 'branch/payload.txt')).rejects.toThrow();
      expect(Buffer.concat(received)).toHaveLength(0);
      expect(swaps).toBeGreaterThanOrEqual(3);
      for (const handle of openedHandles) await expect(handle.stat()).rejects.toThrow();
      expect(await client.send('NOOP')).toMatchObject({ code: 200 });
      expect(await readFile(join(branch, 'payload.txt'), 'utf8')).toBe('inside');
      expect(await readFile(join(outside, 'payload.txt'), 'utf8')).toBe('OUTSIDE-SECRET-CONTENTS');
    } finally {
      client.close();
    }
  });

  it('limits every FTP directory listing command and keeps the control connection usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-list-limit-'));
    roots.push(root);
    const large = join(root, 'large');
    await mkdir(large);
    for (let index = 0; index <= 1_000; index += 1) {
      await writeFile(join(large, `entry-${String(index).padStart(4, '0')}.txt`), 'x');
    }
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_368,
      passivePortEnd: 50_375,
    });
    stops.push(server.stop);
    const client = new FtpClient(5_000);
    try {
      await client.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'tester',
        password: 'widget-password',
      });
      for (const verb of ['LIST', 'NLST', 'MLSD']) {
        await client.send('PASV');
        await expect(client.send(`${verb} large`)).rejects.toMatchObject({ code: 550 });
        expect((await client.send('NOOP')).code).toBe(200);
      }
      expect((await client.list()).map(({ name }) => name)).toContain('large');
      await rename(large, join(root, 'moved'));
      expect((await client.list()).map(({ name }) => name)).toContain('moved');
      await unlink(join(root, 'moved', 'entry-1000.txt'));
      expect(await client.list('moved')).toHaveLength(1_000);
    } finally {
      client.close();
    }
  });

  it('serves authenticated FTP on IPv6 loopback with EPSV and a bracketed local URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-ipv6-loopback-'));
    roots.push(root);
    await writeFile(join(root, 'ipv6.txt'), 'ipv6-loopback');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '::1',
      port: 0,
      anonymous: false,
      username: 'ipv6-user',
      password: 'ipv6-session-only',
      passivePortStart: 50_384,
      passivePortEnd: 50_391,
    });
    stops.push(server.stop);
    expect(server.host).toBe('::1');
    expect(server.url).toBe(`ftp://[::1]:${server.port}`);

    const denied = new FtpClient(5_000);
    await expect(
      denied.access({
        host: '::1',
        port: server.port,
        user: 'ipv6-user',
        password: 'wrong-password',
      }),
    ).rejects.toThrow();
    denied.close();

    const client = new FtpClient(5_000);
    await client.access({
      host: '::1',
      port: server.port,
      user: 'ipv6-user',
      password: 'ipv6-session-only',
    });
    await expect(client.send('PASV')).rejects.toThrow(/522 Use EPSV for IPv6/u);
    const extendedPassive = await client.send('EPSV');
    const passivePort = Number(extendedPassive.message.match(/\(\|\|\|(\d+)\|\)/u)?.[1]);
    expect(passivePort).toBeGreaterThanOrEqual(50_384);
    expect(passivePort).toBeLessThanOrEqual(50_391);
    expect((await client.list()).map(({ name }) => name)).toContain('ipv6.txt');
    await client.uploadFrom(Readable.from(Buffer.from('uploaded-over-ipv6')), 'uploaded.txt');
    const activeChunks: Buffer[] = [];
    let activeSocket: Socket | undefined;
    let finishActive!: () => void;
    const activeReceived = new Promise<void>((resolveData) => {
      finishActive = resolveData;
    });
    const activeListener = createServer((socket) => {
      activeSocket = socket;
      socket.on('data', (chunk: Buffer) => activeChunks.push(chunk));
      socket.once('end', finishActive);
    });
    await new Promise<void>((resolveListen) => activeListener.listen(0, '::1', resolveListen));
    try {
      const activeAddress = activeListener.address();
      expect(activeAddress && typeof activeAddress !== 'string').toBe(true);
      const activePort =
        typeof activeAddress === 'string' || !activeAddress ? 0 : activeAddress.port;
      await expect(client.send(`EPRT |1|127.0.0.1|${activePort}|`)).rejects.toThrow(
        /501 Invalid active data address/u,
      );
      await client.send(`EPRT |2|::1|${activePort}|`);
      await client.send('NLST');
      await withDeadline(activeReceived, 'IPv6 active data');
      expect(Buffer.concat(activeChunks).toString('utf8')).toContain('ipv6.txt');
      expect(Buffer.concat(activeChunks).toString('utf8')).toContain('uploaded.txt');
    } finally {
      activeSocket?.destroy();
      await new Promise<void>((resolveClose) => activeListener.close(() => resolveClose()));
    }
    client.close();
    expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('uploaded-over-ipv6');

    await server.stop();
    await expect(
      new Promise<void>((resolveConnect, rejectConnect) => {
        const socket = connect({ host: '::1', port: server.port });
        socket.once('connect', () => {
          socket.destroy();
          rejectConnect(new Error('Stopped IPv6 FTP listener accepted a connection'));
        });
        socket.once('error', () => resolveConnect());
      }),
    ).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'interoperates with the system curl FTP client over PASV and active data channels without accepting a bad password',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-curl-'));
      const transfer = await mkdtemp(join(tmpdir(), 'axterm-ftp-curl-transfer-'));
      roots.push(root, transfer);
      const payload = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(8_192, 0xa5)]);
      const source = join(transfer, 'curl-upload.bin');
      const downloaded = join(transfer, 'curl-downloaded.bin');
      await writeFile(join(root, 'listed.txt'), 'listed-by-curl');
      await writeFile(source, payload);
      const server = await new NodeLocalFtpServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        anonymous: false,
        username: 'curl-user',
        password: 'curl-session-only',
        passivePortStart: 50_352,
        passivePortEnd: 50_359,
      });
      stops.push(server.stop);
      const baseUrl = `ftp://127.0.0.1:${server.port}/`;
      const shared = [
        '--silent',
        '--show-error',
        '--disable-epsv',
        '--max-time',
        '10',
        '--user',
        'curl-user:curl-session-only',
      ];

      const listed = await runCurl([...shared, '--list-only', baseUrl]);
      expect(listed.code).toBe(0);
      expect(listed.stdout.toString('utf8')).toContain('listed.txt');

      const uploaded = await runCurl([
        ...shared,
        '--upload-file',
        source,
        `${baseUrl}curl-upload.bin`,
      ]);
      expect(uploaded.code).toBe(0);
      expect(await readFile(join(root, 'curl-upload.bin'))).toEqual(payload);

      const fetched = await runCurl([
        ...shared,
        '--output',
        downloaded,
        `${baseUrl}curl-upload.bin`,
      ]);
      expect(fetched.code).toBe(0);
      expect(await readFile(downloaded)).toEqual(payload);

      const activeUploaded = await runCurl([
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--user',
        'curl-user:curl-session-only',
        '--ftp-port',
        '-',
        '--upload-file',
        source,
        `${baseUrl}curl-active-upload.bin`,
      ]);
      expect(activeUploaded.code).toBe(0);
      expect(await readFile(join(root, 'curl-active-upload.bin'))).toEqual(payload);

      const activeDownloaded = join(transfer, 'curl-active-downloaded.bin');
      const activeFetched = await runCurl([
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--user',
        'curl-user:curl-session-only',
        '--ftp-port',
        '-',
        '--output',
        activeDownloaded,
        `${baseUrl}curl-active-upload.bin`,
      ]);
      expect(activeFetched.code).toBe(0);
      expect(await readFile(activeDownloaded)).toEqual(payload);

      const denied = await runCurl([
        '--silent',
        '--show-error',
        '--fail',
        '--disable-epsv',
        '--max-time',
        '10',
        '--user',
        'curl-user:wrong-password',
        '--list-only',
        baseUrl,
      ]);
      expect(denied.code).not.toBe(0);
    },
    45_000,
  );

  it('supports anonymous FTP without global signal handlers and releases its port on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-anonymous-'));
    roots.push(root);
    const signalCounts = (['SIGINT', 'SIGTERM', 'SIGQUIT'] as const).map((signal) =>
      process.listenerCount(signal),
    );
    const adapter = new NodeLocalFtpServer();
    const server = await adapter.start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_328,
      passivePortEnd: 50_335,
    });
    stops.push(server.stop);
    const client = new FtpClient(5_000);
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'anonymous',
      password: 'visitor',
    });
    await client.uploadFrom(Readable.from(Buffer.from('public')), 'public.txt');
    const response = await client.send('EPSV');
    const port = Number(response.message.match(/\(\|\|\|(\d+)\|\)/)?.[1]);
    expect(port).toBeGreaterThanOrEqual(50_328);
    expect(port).toBeLessThanOrEqual(50_335);
    await server.stop();
    client.close();
    expect(await readFile(join(root, 'public.txt'), 'utf8')).toBe('public');
    expect(
      (['SIGINT', 'SIGTERM', 'SIGQUIT'] as const).map((signal) => process.listenerCount(signal)),
    ).toEqual(signalCounts);
    const restarted = await adapter.start({
      rootPath: root,
      host: '127.0.0.1',
      port: server.port,
      anonymous: true,
      username: '',
      passivePortStart: 50_328,
      passivePortEnd: 50_335,
    });
    stops.push(restarted.stop);
    expect(restarted.port).toBe(server.port);
  });

  it('rejects non-loopback FTP binds before opening a control or passive listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-loopback-only-'));
    roots.push(root);
    await expect(
      new NodeLocalFtpServer().start({
        rootPath: root,
        host: '0.0.0.0',
        port: 0,
        anonymous: false,
        username: 'tester',
        password: 'widget-password',
        passivePortStart: 50_376,
        passivePortEnd: 50_376,
      }),
    ).rejects.toThrow('FTP Widget may bind only to a loopback address');
  });

  it('caps FTP control sessions and reclaims a session slot after its peer disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-control-limit-'));
    roots.push(root);
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_360,
      passivePortEnd: 50_367,
    });
    stops.push(server.stop);

    const controls: Socket[] = [];
    try {
      for (let index = 0; index < 16; index += 1) controls.push(await openFtpControl(server.port));

      const rejected = connect(server.port, '127.0.0.1');
      rejected.on('error', () => undefined);
      const rejectedClosed = once(rejected, 'close');
      await rejectedClosed;
      expect(rejected.destroyed).toBe(true);

      const released = controls.shift();
      if (!released) throw new Error('FTP control fixture did not retain a connection');
      const releasedClosed = once(released, 'close');
      released.destroy();
      await releasedClosed;

      const replacement = await openFtpControl(server.port);
      controls.push(replacement);
    } finally {
      for (const control of controls) control.destroy();
    }
  });

  it('stops an in-flight upload and removes staging data without replacing an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-stop-'));
    roots.push(root);
    await writeFile(join(root, 'existing.txt'), 'original');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_336,
      passivePortEnd: 50_343,
    });
    stops.push(server.stop);
    const client = new FtpClient(5_000);
    await client.access({
      host: '127.0.0.1',
      port: server.port,
      user: 'tester',
      password: 'widget-password',
    });
    const source = new PassThrough();
    const uploadResult = client.uploadFrom(source, 'existing.txt').then(
      () => 'completed',
      () => 'failed',
    );
    source.write('partial');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readdir(root)).some((name) => name.endsWith('.part'))) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect((await readdir(root)).some((name) => name.endsWith('.part'))).toBe(true);
    await server.stop();
    source.destroy();
    client.close();
    expect(await uploadResult).toBe('failed');
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['existing.txt']);
  });

  it('cleans an in-flight upload after an abrupt control disconnect and accepts a new session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-control-drop-'));
    roots.push(root);
    await writeFile(join(root, 'existing.bin'), 'original');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_464,
      passivePortEnd: 50_471,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    let data: Socket | undefined;
    try {
      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'control-drop USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'control-drop PASS reply')).toMatch(/^230 /u);
      control.write('TYPE I\r\n');
      expect(await withDeadline(replies.next(), 'control-drop TYPE reply')).toMatch(/^200 /u);
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), 'control-drop PASV reply');
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      if (!values) throw new Error('FTP passive reply has no data address');
      const port = Number(values[5]) * 256 + Number(values[6]);
      data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      await withDeadline(once(data, 'connect'), 'control-drop data connection');
      control.write('STOR existing.bin\r\n');
      expect(await withDeadline(replies.next(), 'control-drop STOR opening reply')).toMatch(
        /^150 /u,
      );
      data.write('partial upload before control loss');
      let stagedBytes = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const stage = (await readdir(root)).find((name) => name.endsWith('.part'));
        if (stage) {
          stagedBytes = (await stat(join(root, stage))).size;
          if (stagedBytes > 0) break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(stagedBytes).toBeGreaterThan(0);
      const closed = once(control, 'close');
      control.destroy();
      await withDeadline(closed, 'abrupt control close');
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!(await readdir(root)).some((name) => name.endsWith('.part'))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(await readFile(join(root, 'existing.bin'), 'utf8')).toBe('original');
      expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
      const recovered = new FtpClient(5_000);
      try {
        await recovered.access({
          host: '127.0.0.1',
          port: server.port,
          user: 'anonymous',
          password: 'visitor',
        });
        expect((await recovered.send('NOOP')).code).toBe(200);
      } finally {
        recovered.close();
      }
    } finally {
      data?.destroy();
      replies.close();
      control.destroy();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects an upload when its destination directory changes and removes the root-anchored staging file',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-upload-target-swap-'));
      roots.push(root);
      const incoming = join(root, 'incoming');
      const moved = join(root, 'moved');
      const replacement = join(root, 'replacement');
      await mkdir(incoming);
      await mkdir(replacement);
      const server = await new NodeLocalFtpServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        anonymous: false,
        username: 'tester',
        password: 'widget-password',
        passivePortStart: 50_378,
        passivePortEnd: 50_385,
      });
      stops.push(server.stop);
      const client = new FtpClient(5_000);
      await client.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'tester',
        password: 'widget-password',
      });
      const source = new PassThrough();
      const uploadResult = client.uploadFrom(source, 'incoming/payload.bin').then(
        () => 'completed',
        () => 'failed',
      );
      source.write('partial-secret');
      let stagingName: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rootEntries = await readdir(root);
        const incomingEntries = await readdir(incoming);
        stagingName = [...rootEntries, ...incomingEntries].find((name) => name.endsWith('.part'));
        if (stagingName) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(stagingName).toBeDefined();
      expect((await readdir(root)).find((name) => name.endsWith('.part'))).toBe(stagingName);

      const observer = new FtpClient(5_000);
      await observer.access({
        host: '127.0.0.1',
        port: server.port,
        user: 'tester',
        password: 'widget-password',
      });
      expect((await observer.list()).map(({ name }) => name)).not.toContain(stagingName);
      await expect(observer.send(`SIZE ${stagingName}`)).rejects.toThrow();
      observer.close();

      await rename(incoming, moved);
      await symlink(replacement, incoming);
      source.end('-remaining-bytes');

      expect(await uploadResult).toBe('failed');
      expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
      expect((await readdir(moved)).filter((name) => name.endsWith('.part'))).toEqual([]);
      expect(await readdir(replacement)).toEqual([]);
      await expect(readFile(join(replacement, 'payload.bin'))).rejects.toThrow();
      const noop = await client.send('NOOP');
      expect(noop.code).toBe(200);
      client.close();
    },
  );

  it('rejects RNTO when the source pathname was replaced after RNFR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-rename-source-swap-'));
    roots.push(root);
    const source = join(root, 'source.txt');
    const original = join(root, 'original.txt');
    const destination = join(root, 'destination.txt');
    await writeFile(source, 'original-source');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_386,
      passivePortEnd: 50_393,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    try {
      control.write('USER tester\r\n');
      expect(await withDeadline(replies.next(), 'rename USER reply')).toMatch(/^331 /u);
      control.write('PASS widget-password\r\n');
      expect(await withDeadline(replies.next(), 'rename PASS reply')).toMatch(/^230 /u);
      control.write('RNFR source.txt\r\n');
      expect(await withDeadline(replies.next(), 'RNFR reply')).toMatch(/^350 /u);

      await rename(source, original);
      await writeFile(source, 'replacement-source');
      control.write('RNTO destination.txt\r\n');
      expect(await withDeadline(replies.next(), 'changed-source RNTO reply')).toMatch(/^550 /u);

      expect(await readFile(original, 'utf8')).toBe('original-source');
      expect(await readFile(source, 'utf8')).toBe('replacement-source');
      await expect(readFile(destination, 'utf8')).rejects.toThrow();
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'NOOP after changed RNFR source')).toMatch(
        /^200 /u,
      );
    } finally {
      replies.close();
      control.destroy();
    }
  });

  it('requires RNTO to immediately follow RNFR on the same control connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-rename-sequence-'));
    roots.push(root);
    const source = join(root, 'source.txt');
    const destination = join(root, 'destination.txt');
    await writeFile(source, 'rename-sequence');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: false,
      username: 'tester',
      password: 'widget-password',
      passivePortStart: 50_410,
      passivePortEnd: 50_417,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    try {
      control.write('USER tester\r\n');
      expect(await withDeadline(replies.next(), 'rename sequence USER reply')).toMatch(/^331 /u);
      control.write('PASS widget-password\r\n');
      expect(await withDeadline(replies.next(), 'rename sequence PASS reply')).toMatch(/^230 /u);

      control.write('RNFR source.txt\r\n');
      expect(await withDeadline(replies.next(), 'first RNFR reply')).toMatch(/^350 /u);
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'intervening NOOP reply')).toMatch(/^200 /u);
      control.write('RNTO destination.txt\r\n');
      expect(await withDeadline(replies.next(), 'non-immediate RNTO reply')).toMatch(/^503 /u);
      expect(await readFile(source, 'utf8')).toBe('rename-sequence');
      await expect(readFile(destination, 'utf8')).rejects.toThrow();

      control.write('RNFR source.txt\r\n');
      expect(await withDeadline(replies.next(), 'second RNFR reply')).toMatch(/^350 /u);
      control.write('RNTO destination.txt\r\n');
      expect(await withDeadline(replies.next(), 'immediate RNTO reply')).toMatch(/^250 /u);
      await expect(readFile(source, 'utf8')).rejects.toThrow();
      expect(await readFile(destination, 'utf8')).toBe('rename-sequence');

      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'NOOP after valid rename')).toMatch(/^200 /u);
    } finally {
      replies.close();
      control.destroy();
    }
  });

  it('advertises RFC 3659 file features and consumes the restart marker on the immediately following transfer attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-rest-state-'));
    roots.push(root);
    await writeFile(join(root, 'payload.txt'), '0123456789');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_394,
      passivePortEnd: 50_401,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    const retrieve = async (label: string, restartOffset?: number) => {
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), `${label} PASV reply`);
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      const data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      const chunks: Buffer[] = [];
      data.on('data', (chunk: Buffer) => chunks.push(chunk));
      await withDeadline(once(data, 'connect'), `${label} data connection`);
      if (restartOffset !== undefined) {
        control.write(`REST ${restartOffset}\r\n`);
        expect(await withDeadline(replies.next(), `${label} REST reply`)).toMatch(/^350 /u);
      }
      const ended = once(data, 'end');
      control.write('RETR payload.txt\r\n');
      expect(await withDeadline(replies.next(), `${label} RETR opening reply`)).toMatch(/^150 /u);
      await withDeadline(ended, `${label} data end`);
      expect(await withDeadline(replies.next(), `${label} RETR completion reply`)).toMatch(
        /^226 /u,
      );
      return Buffer.concat(chunks).toString('utf8');
    };
    const store = async (label: string, value: string, restartOffset?: number) => {
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), `${label} PASV reply`);
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      const data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      await withDeadline(once(data, 'connect'), `${label} data connection`);
      if (restartOffset !== undefined) {
        control.write(`REST ${restartOffset}\r\n`);
        expect(await withDeadline(replies.next(), `${label} REST reply`)).toMatch(/^350 /u);
      }
      const closed = once(data, 'close');
      control.write('STOR payload.txt\r\n');
      expect(await withDeadline(replies.next(), `${label} STOR opening reply`)).toMatch(/^150 /u);
      data.end(value);
      await withDeadline(closed, `${label} data close`);
      expect(await withDeadline(replies.next(), `${label} STOR completion reply`)).toMatch(
        /^226 /u,
      );
    };
    try {
      control.write('FEAT\r\n');
      const features: string[] = [];
      while (!features.at(-1)?.startsWith('211 End'))
        features.push(await withDeadline(replies.next(), 'FEAT reply'));
      expect(features).toContain(' REST STREAM');
      expect(features).toContain(' MDTM');
      expect(features).toContain(' SIZE');
      expect(features.filter((feature) => feature === ' MDTM')).toHaveLength(1);
      expect(features.filter((feature) => feature === ' SIZE')).toHaveLength(1);

      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'REST USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'REST PASS reply')).toMatch(/^230 /u);

      control.write('REST 4\r\n');
      expect(await withDeadline(replies.next(), 'failed-transfer REST reply')).toMatch(/^350 /u);
      control.write('RETR missing.txt\r\n');
      expect(await withDeadline(replies.next(), 'failed RETR reply')).toMatch(/^550 /u);
      expect(await retrieve('after failed RETR')).toBe('0123456789');

      control.write('REST 4\r\n');
      expect(await withDeadline(replies.next(), 'non-immediate REST reply')).toMatch(/^350 /u);
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'NOOP after REST')).toMatch(/^200 /u);
      expect(await retrieve('after intervening NOOP')).toBe('0123456789');

      expect(await retrieve('valid resumed RETR', 4)).toBe('456789');

      control.write('REST 99\r\n');
      expect(await withDeadline(replies.next(), 'out-of-range STOR REST reply')).toMatch(/^350 /u);
      control.write('STOR payload.txt\r\n');
      expect(await withDeadline(replies.next(), 'out-of-range STOR reply')).toMatch(/^550 /u);
      expect(await readFile(join(root, 'payload.txt'), 'utf8')).toBe('0123456789');
      await store('after rejected resumed STOR', 'fresh-file');
      expect(await readFile(join(root, 'payload.txt'), 'utf8')).toBe('fresh-file');

      await writeFile(join(root, 'payload.txt'), 'ABCDobsolete-tail');
      await store('valid resumed STOR', '456789', 4);
      expect(await readFile(join(root, 'payload.txt'), 'utf8')).toBe('ABCD456789');
    } finally {
      replies.close();
      control.destroy();
    }
  });

  it.each(['stat', 'read'] as const)(
    'closes a resumed-upload source when its %s fails before opening data',
    async (failingOperation) => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-rest-read-error-'));
      roots.push(root);
      const target = join(root, 'payload.txt');
      await writeFile(target, 'unchanged-source');
      let sourceHandle: FileHandle | undefined;
      let closeCalls = 0;
      const sourceFailure = Object.assign(
        new Error(`Injected FTP restart ${failingOperation} failure`),
        {
          code: 'EIO',
        },
      );
      const server = await new NodeLocalFtpServer(undefined, async (path, flags) => {
        const handle = await open(path, flags);
        sourceHandle = handle;
        return new Proxy(handle, {
          get(current, property) {
            if (property === failingOperation) return async () => Promise.reject(sourceFailure);
            if (property === 'close')
              return async () => {
                closeCalls += 1;
                return current.close();
              };
            const value: unknown = Reflect.get(current, property, current);
            return typeof value === 'function' ? value.bind(current) : value;
          },
        });
      }).start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        anonymous: true,
        username: '',
        passivePortStart: 50_394,
        passivePortEnd: 50_401,
      });
      stops.push(server.stop);
      const control = await openFtpControl(server.port);
      const replies = ftpReplyReader(control);
      try {
        control.write('USER anonymous\r\n');
        expect(await withDeadline(replies.next(), 'restart read USER')).toMatch(/^331 /u);
        control.write('PASS visitor\r\n');
        expect(await withDeadline(replies.next(), 'restart read PASS')).toMatch(/^230 /u);
        control.write('REST 1\r\n');
        expect(await withDeadline(replies.next(), 'restart read REST')).toMatch(/^350 /u);
        control.write('STOR payload.txt\r\n');
        expect(await withDeadline(replies.next(), 'restart read STOR')).toMatch(/^550 /u);
        expect(closeCalls).toBe(1);
        expect(await readFile(target, 'utf8')).toBe('unchanged-source');
        control.write('NOOP\r\n');
        expect(await withDeadline(replies.next(), 'NOOP after restart read failure')).toMatch(
          /^200 /u,
        );
      } finally {
        replies.close();
        control.destroy();
        await sourceHandle?.close().catch(() => undefined);
      }
    },
  );

  it('converts default TYPE A files to and from NVT-ASCII and restarts at transfer octet offsets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-ascii-'));
    roots.push(root);
    const localBytes = Buffer.from([0x0a, 0x41, 0x0a, 0x42, 0x0d, 0x0a, 0x43, 0x0d, 0x44]);
    const uploadedAsciiBytes = Buffer.concat([
      Buffer.from(EOL),
      Buffer.from([0x41]),
      Buffer.from(EOL),
      Buffer.from([0x42]),
      Buffer.from(EOL),
      Buffer.from([0x43, 0x0d, 0x44]),
    ]);
    const nvtBytes = Buffer.from([
      0x0d, 0x0a, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x43, 0x0d, 0x00, 0x44,
    ]);
    const file = join(root, 'payload.txt');
    await writeFile(file, localBytes);
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_394,
      passivePortEnd: 50_401,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    const readTransfer = async (label: string, offset?: number) => {
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), `${label} PASV reply`);
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      const data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      const chunks: Buffer[] = [];
      data.on('data', (chunk: Buffer) => chunks.push(chunk));
      await withDeadline(once(data, 'connect'), `${label} data connection`);
      if (offset !== undefined) {
        control.write(`REST ${offset}\r\n`);
        expect(await withDeadline(replies.next(), `${label} REST reply`)).toMatch(/^350 /u);
      }
      const ended = once(data, 'end');
      control.write('RETR payload.txt\r\n');
      expect(await withDeadline(replies.next(), `${label} RETR opening reply`)).toMatch(/^150 /u);
      await withDeadline(ended, `${label} data end`);
      expect(await withDeadline(replies.next(), `${label} RETR completion reply`)).toMatch(
        /^226 /u,
      );
      return Buffer.concat(chunks);
    };
    const storeTransfer = async (label: string, offset: number, bytes: Buffer) => {
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), `${label} PASV reply`);
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      const data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      await withDeadline(once(data, 'connect'), `${label} data connection`);
      control.write(`REST ${offset}\r\n`);
      expect(await withDeadline(replies.next(), `${label} REST reply`)).toMatch(/^350 /u);
      control.write('STOR payload.txt\r\n');
      expect(await withDeadline(replies.next(), `${label} STOR opening reply`)).toMatch(/^150 /u);
      const ended = once(data, 'close');
      data.end(bytes);
      await withDeadline(ended, `${label} data close`);
      expect(await withDeadline(replies.next(), `${label} STOR completion reply`)).toMatch(
        /^226 /u,
      );
    };
    try {
      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'ASCII USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'ASCII PASS reply')).toMatch(/^230 /u);

      control.write('SIZE payload.txt\r\n');
      expect(await withDeadline(replies.next(), 'default ASCII SIZE')).toMatch(/^213 12/u);
      expect(await readTransfer('default ASCII RETR')).toEqual(nvtBytes);
      expect(await readTransfer('ASCII restart RETR', 3)).toEqual(nvtBytes.subarray(3));

      control.write('TYPE i\r\n');
      expect(await withDeadline(replies.next(), 'case-insensitive TYPE I')).toMatch(/^200 /u);
      control.write('SIZE payload.txt\r\n');
      expect(await withDeadline(replies.next(), 'binary SIZE')).toMatch(/^213 9/u);
      expect(await readTransfer('binary RETR')).toEqual(localBytes);

      control.write('TYPE a\r\n');
      expect(await withDeadline(replies.next(), 'case-insensitive TYPE A')).toMatch(/^200 /u);
      for (let offset = 0; offset <= nvtBytes.length; offset += 1) {
        await writeFile(file, localBytes);
        await storeTransfer(`ASCII STOR REST ${offset}`, offset, nvtBytes.subarray(offset));
        if (offset === 0) expect(await readFile(file)).toEqual(uploadedAsciiBytes);
        expect(await readTransfer(`ASCII RETR after REST ${offset}`)).toEqual(nvtBytes);
      }
      expect(await readFile(file)).toEqual(localBytes);
      control.write('SIZE payload.txt\r\n');
      expect(await withDeadline(replies.next(), 'resumed ASCII SIZE')).toMatch(/^213 12/u);
    } finally {
      replies.close();
      control.destroy();
    }
  });

  for (const restartOffset of [0, 4] as const) {
    for (const code of ['ENOSPC', 'EACCES', 'EIO'] as const) {
      it(`cleans a partial ${restartOffset ? 'REST STOR' : 'STOR'} after ${code} without replacing the target`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-partial-write-'));
        roots.push(root);
        const target = join(root, 'payload.bin');
        const original = Buffer.from('ABCD-original-tail');
        if (restartOffset) await writeFile(target, original);
        let stagedBytes = 0;
        const failure = Object.assign(new Error(`Injected FTP staging write ${code}`), { code });
        const server = await new NodeLocalFtpServer(
          partialFailureFactory(restartOffset ? 'a' : 'wx', failure, (bytes) => {
            stagedBytes += bytes;
          }),
        ).start({
          rootPath: root,
          host: '127.0.0.1',
          port: 0,
          anonymous: true,
          username: '',
          passivePortStart: 50_410,
          passivePortEnd: 50_417,
        });
        stops.push(server.stop);
        const control = await openFtpControl(server.port);
        const replies = ftpReplyReader(control);
        let data: Socket | undefined;
        try {
          control.write('USER anonymous\r\n');
          expect(await withDeadline(replies.next(), `${code} USER reply`)).toMatch(/^331 /u);
          control.write('PASS visitor\r\n');
          expect(await withDeadline(replies.next(), `${code} PASS reply`)).toMatch(/^230 /u);
          control.write('PASV\r\n');
          const passive = await withDeadline(replies.next(), `${code} PASV reply`);
          const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
          expect(values).toBeTruthy();
          const port = Number(values?.[5]) * 256 + Number(values?.[6]);
          data = connect(port, '127.0.0.1');
          data.on('error', () => undefined);
          await withDeadline(once(data, 'connect'), `${code} data connection`);
          if (restartOffset) {
            control.write(`REST ${restartOffset}\r\n`);
            expect(await withDeadline(replies.next(), `${code} REST reply`)).toMatch(/^350 /u);
          }
          const dataClosed = new Promise<void>((resolveClose) => data?.once('close', resolveClose));
          control.write('STOR payload.bin\r\n');
          expect(await withDeadline(replies.next(), `${code} STOR opening reply`)).toMatch(
            /^150 /u,
          );
          data.end(Buffer.alloc(8_192, 0xa5));
          await withDeadline(dataClosed, `${code} data close`);
          expect(await withDeadline(replies.next(), `${code} STOR failure reply`)).toMatch(
            /^426 /u,
          );

          expect(stagedBytes).toBe(64);
          if (restartOffset) expect(await readFile(target)).toEqual(original);
          else await expect(readFile(target)).rejects.toThrow();
          expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
          control.write('NOOP\r\n');
          expect(await withDeadline(replies.next(), `${code} NOOP after failure`)).toMatch(
            /^200 /u,
          );
        } finally {
          data?.destroy();
          replies.close();
          control.destroy();
        }
      });
    }
  }

  it.skipIf(process.platform === 'win32')(
    'rejects a resumed STOR when the source file is replaced during transfer',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-rest-source-swap-'));
      roots.push(root);
      const target = join(root, 'payload.txt');
      const original = join(root, 'original.txt');
      await writeFile(target, 'ABCD-original-tail');
      const server = await new NodeLocalFtpServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        anonymous: true,
        username: '',
        passivePortStart: 50_402,
        passivePortEnd: 50_409,
      });
      stops.push(server.stop);
      const control = await openFtpControl(server.port);
      const replies = ftpReplyReader(control);
      let data: Socket | undefined;
      try {
        control.write('USER anonymous\r\n');
        expect(await withDeadline(replies.next(), 'source-swap USER reply')).toMatch(/^331 /u);
        control.write('PASS visitor\r\n');
        expect(await withDeadline(replies.next(), 'source-swap PASS reply')).toMatch(/^230 /u);
        control.write('PASV\r\n');
        const passive = await withDeadline(replies.next(), 'source-swap PASV reply');
        const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
        expect(values).toBeTruthy();
        const port = Number(values?.[5]) * 256 + Number(values?.[6]);
        data = connect(port, '127.0.0.1');
        data.on('error', () => undefined);
        await withDeadline(once(data, 'connect'), 'source-swap data connection');
        control.write('REST 4\r\n');
        expect(await withDeadline(replies.next(), 'source-swap REST reply')).toMatch(/^350 /u);
        control.write('STOR payload.txt\r\n');
        expect(await withDeadline(replies.next(), 'source-swap STOR opening reply')).toMatch(
          /^150 /u,
        );
        data.write('resumed');
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await readdir(root)).some((name) => name.endsWith('.part'))) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        expect((await readdir(root)).some((name) => name.endsWith('.part'))).toBe(true);

        await rename(target, original);
        await writeFile(target, 'replacement-file');
        const dataClosed = once(data, 'close');
        data.end('-bytes');
        await withDeadline(dataClosed, 'source-swap data close');
        expect(await withDeadline(replies.next(), 'source-swap STOR failure reply')).toMatch(
          /^426 /u,
        );

        expect(await readFile(original, 'utf8')).toBe('ABCD-original-tail');
        expect(await readFile(target, 'utf8')).toBe('replacement-file');
        expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
        control.write('NOOP\r\n');
        expect(await withDeadline(replies.next(), 'NOOP after source-swap STOR')).toMatch(/^200 /u);
      } finally {
        data?.destroy();
        replies.close();
        control.destroy();
      }
    },
  );

  it('honors ABOR during an active download and leaves the authenticated control channel usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-abor-'));
    roots.push(root);
    await writeFile(join(root, 'large.bin'), Buffer.alloc(32 * 1024 * 1024, 0xa5));
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_368,
      passivePortEnd: 50_375,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    let data: Socket | undefined;
    try {
      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'PASS reply')).toMatch(/^230 /u);
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), 'PASV reply');
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      data = connect(port, '127.0.0.1');
      data.on('error', () => undefined);
      await withDeadline(once(data, 'connect'), 'data connection');
      const dataStarted = new Promise<void>((resolveStarted) => {
        data?.once('data', () => {
          data?.pause();
          resolveStarted();
        });
      });
      control.write('RETR large.bin\r\n');
      expect(await withDeadline(replies.next(), 'RETR opening reply')).toMatch(/^150 /u);
      await withDeadline(dataStarted, 'download data');
      control.write('ABOR\r\n');
      expect(await withDeadline(replies.next(), 'RETR abort reply')).toMatch(/^426 /u);
      expect(await withDeadline(replies.next(), 'ABOR completion reply')).toMatch(/^226 /u);
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'NOOP after ABOR')).toMatch(/^200 /u);
    } finally {
      data?.destroy();
      replies.close();
      control.destroy();
    }
  });

  for (const restartOffset of [0, 4]) {
    it(`honors ABOR during an active ${restartOffset ? 'resumed ' : ''}upload without replacing the target`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-upload-abor-'));
      roots.push(root);
      await writeFile(join(root, 'existing.bin'), 'ABCD-original-tail');
      const server = await new NodeLocalFtpServer().start({
        rootPath: root,
        host: '127.0.0.1',
        port: 0,
        anonymous: true,
        username: '',
        passivePortStart: 50_456,
        passivePortEnd: 50_463,
      });
      stops.push(server.stop);
      const control = await openFtpControl(server.port);
      const replies = ftpReplyReader(control);
      let data: Socket | undefined;
      try {
        control.write('USER anonymous\r\n');
        expect(await withDeadline(replies.next(), 'upload ABOR USER reply')).toMatch(/^331 /u);
        control.write('PASS visitor\r\n');
        expect(await withDeadline(replies.next(), 'upload ABOR PASS reply')).toMatch(/^230 /u);
        control.write('TYPE I\r\n');
        expect(await withDeadline(replies.next(), 'upload ABOR TYPE reply')).toMatch(/^200 /u);
        control.write('PASV\r\n');
        const passive = await withDeadline(replies.next(), 'upload ABOR PASV reply');
        const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
        expect(values).toBeTruthy();
        const port = Number(values?.[5]) * 256 + Number(values?.[6]);
        data = connect(port, '127.0.0.1');
        data.on('error', () => undefined);
        await withDeadline(once(data, 'connect'), 'upload ABOR data connection');
        if (restartOffset > 0) {
          control.write(`REST ${restartOffset}\r\n`);
          expect(await withDeadline(replies.next(), 'upload ABOR REST reply')).toMatch(/^350 /u);
        }
        control.write('STOR existing.bin\r\n');
        expect(await withDeadline(replies.next(), 'upload ABOR STOR opening reply')).toMatch(
          /^150 /u,
        );
        data.write('partial upload');
        let stagedBytes = 0;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const stage = (await readdir(root)).find((name) => name.endsWith('.part'));
          if (stage) {
            stagedBytes = (await stat(join(root, stage))).size;
            if (stagedBytes > 0) break;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        expect(stagedBytes).toBeGreaterThan(0);
        control.write('ABOR\r\n');
        expect(await withDeadline(replies.next(), 'upload abort reply')).toMatch(/^426 /u);
        expect(await withDeadline(replies.next(), 'upload ABOR completion reply')).toMatch(
          /^226 /u,
        );
        expect(await readFile(join(root, 'existing.bin'), 'utf8')).toBe('ABCD-original-tail');
        expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
        control.write('NOOP\r\n');
        expect(await withDeadline(replies.next(), 'NOOP after upload ABOR')).toMatch(/^200 /u);
      } finally {
        data?.destroy();
        replies.close();
        control.destroy();
      }
    });
  }

  it('honors ABOR while a PASV transfer is waiting for its data connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-abor-pending-'));
    roots.push(root);
    await writeFile(join(root, 'pending.bin'), Buffer.alloc(8_192, 0xa5));
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_376,
      passivePortEnd: 50_376,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    try {
      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'pending USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'pending PASS reply')).toMatch(/^230 /u);
      control.write('PASV\r\n');
      expect(await withDeadline(replies.next(), 'first PASV reply')).toMatch(/^227 /u);
      control.write('RETR pending.bin\r\n');
      expect(await withDeadline(replies.next(), 'pending RETR opening reply')).toMatch(/^150 /u);
      control.write('ABOR\r\n');
      expect(await withDeadline(replies.next(), 'pending RETR abort reply')).toMatch(/^426 /u);
      expect(await withDeadline(replies.next(), 'pending ABOR completion reply')).toMatch(/^226 /u);
      control.write('PASV\r\n');
      expect(await withDeadline(replies.next(), 'released PASV reply')).toMatch(/^227 /u);
      control.write('ABOR\r\n');
      expect(await withDeadline(replies.next(), 'idle ABOR completion reply')).toMatch(/^226 /u);
      control.write('NOOP\r\n');
      expect(await withDeadline(replies.next(), 'NOOP after pending ABOR')).toMatch(/^200 /u);
    } finally {
      replies.close();
      control.destroy();
    }
  });

  it('retains only one same-peer socket for a PASV transfer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-pasv-peer-limit-'));
    roots.push(root);
    await writeFile(join(root, 'listed.txt'), 'bounded passive peer');
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_377,
      passivePortEnd: 50_377,
    });
    stops.push(server.stop);
    const control = await openFtpControl(server.port);
    const replies = ftpReplyReader(control);
    const candidates: Socket[] = [];
    const candidateSettled: Promise<void>[] = [];
    try {
      control.write('USER anonymous\r\n');
      expect(await withDeadline(replies.next(), 'peer-limit USER reply')).toMatch(/^331 /u);
      control.write('PASS visitor\r\n');
      expect(await withDeadline(replies.next(), 'peer-limit PASS reply')).toMatch(/^230 /u);
      control.write('PASV\r\n');
      const passive = await withDeadline(replies.next(), 'peer-limit PASV reply');
      const values = passive.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/u);
      expect(values).toBeTruthy();
      const port = Number(values?.[5]) * 256 + Number(values?.[6]);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = connect(port, '127.0.0.1');
        candidate.on('error', () => undefined);
        candidateSettled.push(
          new Promise<void>((resolveCandidate) => {
            candidate.once('connect', () => setTimeout(resolveCandidate, 25));
            candidate.once('error', resolveCandidate);
            candidate.once('close', resolveCandidate);
          }),
        );
        candidate.resume();
        candidates.push(candidate);
      }
      await Promise.all(candidateSettled);
      const retained = candidates.filter((candidate) => !candidate.destroyed);
      expect(retained).toHaveLength(1);
      control.write('RETR listed.txt\r\n');
      expect(await withDeadline(replies.next(), 'peer-limit RETR opening reply')).toMatch(/^150 /u);
      expect(await withDeadline(replies.next(), 'peer-limit RETR completion reply')).toMatch(
        /^226 /u,
      );
    } finally {
      for (const candidate of candidates) candidate.destroy();
      replies.close();
      control.destroy();
    }
  });

  it('closes an oversized FTP control frame without retaining its input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ftp-frame-'));
    roots.push(root);
    const server = await new NodeLocalFtpServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      anonymous: true,
      username: '',
      passivePortStart: 50_344,
      passivePortEnd: 50_351,
    });
    stops.push(server.stop);
    const socket = connect(server.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const closed = new Promise<void>((resolveClose) => socket.once('close', () => resolveClose()));
    socket.write(`USER ${'x'.repeat(130_000)}`);
    await closed;
    await server.stop();
  });

  it('settles Runtime SFTP cleanup after the real SSH server disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ssh-disconnect-cleanup-'));
    roots.push(root);
    const server = await new NodeLocalSshServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      username: 'tester',
      password: 'fixture-only',
    });
    stops.push(server.stop);
    const handle = await new Ssh2Transport().connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      password: 'fixture-only',
      connectionTimeoutMs: 3_000,
      keepaliveIntervalMs: 0,
      keepaliveCountMax: 1,
      compression: false,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      verifyHostKey: async () => true,
      keyboardInteractive: async () => [],
    });
    const sftp = await handle.openSftp();
    expect(await sftp.realpath('.')).toBe('/');
    const disconnected = new Promise<void>((resolve) => handle.onClose(() => resolve()));
    await server.stop();
    await withDeadline(disconnected, 'SSH disconnect notification');
    await withDeadline(sftp.close(), 'already-ended Runtime SFTP cleanup');
    await withDeadline(sftp.close(), 'repeated Runtime SFTP cleanup');
    await handle.close();
  });

  it('runs password SSH exec and SFTP inside the granted root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-'));
    const outside = await mkdtemp(join(tmpdir(), 'axterm-ssh-widget-outside-'));
    roots.push(root);
    roots.push(outside);
    await writeFile(join(root, 'ssh.txt'), 'ssh-widget');
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(root, 'escape'));
    const server = await new NodeLocalSshServer().start({
      rootPath: root,
      host: '127.0.0.1',
      port: 0,
      username: 'tester',
      password: 'widget-password',
    });
    stops.push(server.stop);
    await expect(connectSsh(server.port, 'tester', 'wrong-password')).rejects.toThrow();

    const client = await connectSsh(server.port, 'tester', 'widget-password');
    const output = await execSsh(client, 'pwd');
    expect(output.trim()).toBe(await realpath(root));
    const sftp = await openSftp(client);
    expect((await listSftp(sftp, '/')).map(({ filename }) => filename)).toContain('ssh.txt');
    await expect(listSftp(sftp, '/escape')).rejects.toThrow();
    await writeSftp(sftp, '/uploaded.txt', 'uploaded-over-sftp');
    expect(await readFile(join(root, 'uploaded.txt'), 'utf8')).toBe('uploaded-over-sftp');
    const ended = once(sftp, 'end');
    sftp.end();
    await withDeadline(ended, 'SFTP EOF acknowledgement');
    // A completed file operation closes its SFTP channel without ending SSH.
    // Subsequent operations must be able to open a fresh channel.
    const next = await openSftp(client);
    expect((await listSftp(next, '/')).map(({ filename }) => filename)).toContain('uploaded.txt');
    const nextEnded = once(next, 'end');
    next.end();
    await withDeadline(nextEnded, 'second SFTP EOF acknowledgement');
    client.end();
  });
});

function connectSsh(port: number, username: string, password: string): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error('SSH connection timed out'));
    }, 5_000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect({
      host: '127.0.0.1',
      port,
      username,
      password,
      readyTimeout: 4_000,
      hostVerifier: () => true,
    });
  });
}

function execSsh(client: SshClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', reject);
      stream.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

function openSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) =>
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
  );
}

function listSftp(sftp: SFTPWrapper, path: string) {
  return new Promise<Parameters<Parameters<SFTPWrapper['readdir']>[1]>[1]>((resolve, reject) =>
    sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries))),
  );
}

function writeSftp(sftp: SFTPWrapper, path: string, value: string): Promise<void> {
  return new Promise((resolve, reject) =>
    sftp.writeFile(path, value, (error) => (error ? reject(error) : resolve())),
  );
}
