import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  SftpCapabilityUnavailableError,
  type SftpAttributes,
  type SftpHandle,
} from '../ports/ssh-transport';
import { SftpService } from './sftp-service';

const attributes = (content: Buffer, mode = 0o100644, mtime = 1): SftpAttributes => ({
  size: content.length,
  mode,
  atime: mtime,
  mtime,
  uid: 501,
  gid: 20,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
});

describe('SftpService', () => {
  it('preserves line endings, detects edit conflicts, applies chmod and closes every channel', async () => {
    const files = new Map<string, { content: Buffer; mode: number; mtime: number }>([
      ['/notes.txt', { content: Buffer.from('一行\r\n二行\r\n'), mode: 0o100640, mtime: 1 }],
    ]);
    let closes = 0;
    let replaceUnavailable = false;
    const chmod = vi.fn(async (path: string, mode: number) => {
      const file = files.get(path)!;
      file.mode = mode;
    });
    const lstat = vi.fn(async (path: string) => {
      const file = files.get(path)!;
      return attributes(file.content, file.mode, file.mtime);
    });
    const handle: SftpHandle = {
      realpath: async (path) => (path === '.' ? '/home/fixture' : path),
      list: async () => [],
      stat: async (path) => {
        if (path === '/home/fixture')
          return {
            ...attributes(Buffer.alloc(0), 0o40700),
            isFile: false,
            isDirectory: true,
          };
        const file = files.get(path)!;
        return attributes(file.content, file.mode, file.mtime);
      },
      lstat,
      mkdir: async () => {},
      rename: async (from, to) => {
        const file = files.get(from)!;
        file.mtime += 1;
        files.set(to, file);
        files.delete(from);
      },
      replace: async (from, to) => {
        if (replaceUnavailable) throw new SftpCapabilityUnavailableError('atomic-replace');
        const file = files.get(from)!;
        file.mtime += 1;
        files.set(to, file);
        files.delete(from);
      },
      unlink: async (path) => {
        files.delete(path);
      },
      rmdir: async () => {},
      chmod,
      readStream: (path) => {
        const content = files.get(path)!.content;
        if (content.length === 0) throw new Error('zero-byte files must not open a read stream');
        return Readable.from(content);
      },
      writeStream: (path) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            files.set(path, { content: Buffer.concat(chunks), mode: 0o100600, mtime: 2 });
            callback();
          },
        });
      },
      close: async () => {
        closes += 1;
      },
    };
    const connections = { handle: () => ({ openSftp: async () => handle }) };
    const service = new SftpService(connections as never);
    await expect(service.home('connection')).resolves.toEqual({ path: '/home/fixture' });
    await service.touch('connection', '/created.txt');
    expect(files.get('/created.txt')?.content.toString()).toBe('');
    const created = await service.readText('connection', '/created.txt');
    expect(created).toMatchObject({ lineEnding: 'lf', content: '' });
    const opened = await service.readText('connection', '/notes.txt');
    expect(opened).toMatchObject({ lineEnding: 'crlf', content: '一行\r\n二行\r\n' });
    files.get('/notes.txt')!.mtime += 1;
    await expect(
      service.writeText('connection', {
        path: opened.path,
        content: '草稿',
        overwriteRevision: opened.revision,
        lineEnding: 'crlf',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_EDIT_CONFLICT' });
    const reopened = await service.readText('connection', '/notes.txt');
    const saved = await service.writeText('connection', {
      path: reopened.path,
      overwriteRevision: reopened.revision,
      content: '甲\n乙\n',
      lineEnding: 'crlf',
    });
    expect(saved.content).toBe('甲\r\n乙\r\n');
    expect(files.get('/notes.txt')!.content.toString()).toBe('甲\r\n乙\r\n');
    await service.chmod('connection', '/notes.txt', 0o600);
    expect(chmod).toHaveBeenLastCalledWith('/notes.txt', 0o600);
    const chmodCalls = chmod.mock.calls.length;
    lstat.mockResolvedValueOnce({
      ...attributes(Buffer.alloc(0)),
      isFile: false,
      isSymbolicLink: true,
    });
    await expect(service.chmod('connection', '/notes-link', 0o777)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(chmod).toHaveBeenCalledTimes(chmodCalls);
    const sameMetadataRevision = await service.readText('connection', '/notes.txt');
    const editedBehindTheEditor = files.get('/notes.txt')!;
    editedBehindTheEditor.content = Buffer.from('丙\r\n丁\r\n');
    await expect(
      service.writeText('connection', {
        path: sameMetadataRevision.path,
        content: 'should conflict',
        overwriteRevision: sameMetadataRevision.revision,
        lineEnding: 'crlf',
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_EDIT_CONFLICT' });
    const withoutAtomicReplace = await service.readText('connection', '/notes.txt');
    replaceUnavailable = true;
    await expect(
      service.writeText('connection', {
        path: withoutAtomicReplace.path,
        content: 'safe failure',
        overwriteRevision: withoutAtomicReplace.revision,
        lineEnding: 'crlf',
      }),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'Remote server does not support safe atomic text replacement',
    });
    expect(closes).toBe(13);
  });

  it('copies and moves files and recursive directories within one SFTP connection', async () => {
    type Entry = { type: 'file' | 'directory'; content: Buffer; mode: number; mtime: number };
    const entries = new Map<string, Entry>([
      ['/', { type: 'directory', content: Buffer.alloc(0), mode: 0o40700, mtime: 1 }],
      ['/target', { type: 'directory', content: Buffer.alloc(0), mode: 0o40700, mtime: 1 }],
      ['/source.txt', { type: 'file', content: Buffer.from('source'), mode: 0o100640, mtime: 1 }],
      ['/folder', { type: 'directory', content: Buffer.alloc(0), mode: 0o40750, mtime: 1 }],
      [
        '/folder/nested.txt',
        { type: 'file', content: Buffer.from('nested'), mode: 0o100644, mtime: 1 },
      ],
    ]);
    const metadata = (path: string): SftpAttributes => {
      const entry = entries.get(path);
      if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        ...attributes(entry.content, entry.mode, entry.mtime),
        isFile: entry.type === 'file',
        isDirectory: entry.type === 'directory',
      };
    };
    let closes = 0;
    const handle: SftpHandle = {
      realpath: async (path) => path,
      list: async (path) =>
        [...entries.entries()]
          .filter(
            ([candidate]) =>
              candidate !== path && candidate.startsWith(`${path === '/' ? '' : path}/`),
          )
          .filter(
            ([candidate]) =>
              !candidate.slice(`${path === '/' ? '/' : `${path}/`}`.length).includes('/'),
          )
          .map(([candidate]) => ({
            filename: candidate.split('/').at(-1)!,
            attrs: metadata(candidate),
          })),
      stat: async (path) => metadata(path),
      lstat: async (path) => metadata(path),
      mkdir: async (path) => {
        if (entries.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        entries.set(path, {
          type: 'directory',
          content: Buffer.alloc(0),
          mode: 0o40700,
          mtime: 2,
        });
      },
      rename: async (from, to) => {
        const entry = entries.get(from);
        if (!entry) throw new Error('missing');
        entries.set(to, entry);
        entries.delete(from);
      },
      replace: async (from, to) => {
        const entry = entries.get(from);
        if (!entry) throw new Error('missing');
        entries.set(to, entry);
        entries.delete(from);
      },
      unlink: async (path) => {
        entries.delete(path);
      },
      rmdir: async (path) => {
        entries.delete(path);
      },
      chmod: async (path, mode) => {
        entries.get(path)!.mode = mode;
      },
      readStream: (path) => Readable.from(entries.get(path)!.content),
      writeStream: (path, options) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            entries.set(path, {
              type: 'file',
              content: Buffer.concat(chunks),
              mode: options?.mode ?? 0o600,
              mtime: 2,
            });
            callback();
          },
        });
      },
      close: async () => {
        closes += 1;
      },
    };
    const service = new SftpService({ handle: () => ({ openSftp: async () => handle }) } as never);

    await service.operate('connection', {
      paths: ['/source.txt'],
      destination: '/',
      operation: 'copy',
      conflict: 'rename',
    });
    expect(entries.get('/source(copy-1).txt')?.content.toString()).toBe('source');
    await service.operate('connection', {
      paths: ['/folder'],
      destination: '/target',
      operation: 'copy',
      conflict: 'rename',
    });
    expect(entries.get('/target/folder/nested.txt')?.content.toString()).toBe('nested');
    await service.operate('connection', {
      paths: ['/source(copy-1).txt'],
      destination: '/target',
      operation: 'move',
      conflict: 'rename',
    });
    expect(entries.has('/source(copy-1).txt')).toBe(false);
    expect(entries.get('/target/source(copy-1).txt')?.content.toString()).toBe('source');
    expect(closes).toBe(3);
  });
});
