import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import type { SftpAttributes, SftpHandle } from '../ports/ssh-transport';
import { RealtimeHub } from './realtime-hub';
import { MAX_ACTIVE_TRANSFERS, TransferService } from './transfer-service';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('TransferService', () => {
  it('routes FTP uploads through an isolated FTP file handle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ftp-transfer-'));
    directories.push(directory);
    const source = join(directory, 'payload.txt');
    await writeFile(source, 'ftp payload');
    const remote = new Map<string, Buffer>();
    const handle: SftpHandle = {
      realpath: async (path) => path,
      list: async () => [],
      stat: async () => {
        throw new Error('missing');
      },
      lstat: async (path) => {
        const content = remote.get(path);
        if (!content) throw new Error('missing');
        return {
          size: content.length,
          mode: 0o644,
          atime: 0,
          mtime: 0,
          uid: 0,
          gid: 0,
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
        };
      },
      mkdir: async () => {},
      rename: async (from, to) => {
        remote.set(to, remote.get(from)!);
        remote.delete(from);
      },
      replace: async () => {},
      unlink: async (path) => {
        remote.delete(path);
      },
      rmdir: async () => {},
      chmod: async () => {},
      readStream: () => Readable.from([]),
      writeStream: (path) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            remote.set(path, Buffer.concat(chunks));
            callback();
          },
        });
      },
      close: vi.fn(async () => {}),
    };
    const host = {
      resolveGrant: async () => ({
        grantId: 'ftp-grant',
        kind: 'file',
        name: 'payload.txt',
        permissions: ['read'],
        createdAt: new Date().toISOString(),
        path: source,
      }),
    };
    const openFiles = vi.fn(async () => handle);
    const database = await ProductDatabase.open();
    const service = new TransferService(
      {
        handle: () => {
          throw new Error('SSH transport must not be used');
        },
      } as never,
      host as never,
      new ProductRepository(database),
      new RealtimeHub(),
      { openFiles } as never,
    );
    const transfer = service.create(
      {
        connectionId: randomUUID(),
        protocol: 'ftp',
        direction: 'upload',
        grantId: 'ftp-grant',
        remotePath: '/payload.txt',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('succeeded'));
    expect(openFiles).toHaveBeenCalledOnce();
    expect(remote.get('/payload.txt')?.toString()).toBe('ftp payload');
    database.close();
  });

  it('requires an idempotency key and cancels streams before shutdown completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-'));
    directories.push(directory);
    const source = join(directory, 'large.bin');
    await writeFile(source, Buffer.alloc(4 * 1024 * 1024, 7));
    let closed = 0;
    const removed: string[] = [];
    const sftp: SftpHandle = {
      realpath: async (path) => path,
      list: async () => [],
      stat: async () => {
        throw new Error('missing');
      },
      lstat: async () => {
        throw new Error('missing');
      },
      mkdir: async () => {},
      rename: async () => {},
      replace: async () => {},
      unlink: async (path) => {
        removed.push(path);
      },
      rmdir: async () => {},
      chmod: async () => {},
      readStream: () => Readable.from([]),
      writeStream: () =>
        new Writable({
          highWaterMark: 1024,
          write(_chunk, _encoding, callback) {
            setTimeout(callback, 3);
          },
        }),
      close: async () => {
        closed += 1;
      },
    };
    const connections = { handle: () => ({ openSftp: async () => sftp }) };
    const host = {
      resolveGrant: async () => ({
        grantId: 'grant',
        kind: 'file',
        name: 'large.bin',
        permissions: ['read'],
        createdAt: new Date().toISOString(),
        path: source,
      }),
    };
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const service = new TransferService(
      connections as never,
      host as never,
      repository,
      new RealtimeHub(),
    );
    expect(() =>
      service.create(
        {
          connectionId: randomUUID(),
          direction: 'upload',
          grantId: 'grant',
          remotePath: '/large.bin',
          recursive: false,
          conflict: 'overwrite',
        },
        undefined,
      ),
    ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_REQUIRED' }));
    const transfer = service.create(
      {
        connectionId: randomUUID(),
        direction: 'upload',
        grantId: 'grant',
        remotePath: '/large.bin',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('running'));
    service.pause(transfer.id);
    expect(service.get(transfer.id).state).toBe('paused');
    service.resume(transfer.id);
    expect(service.get(transfer.id).state).toBe('running');
    service.cancel(transfer.id);
    await service.closeAll();
    expect(service.get(transfer.id).state).toBe('canceled');
    expect(service.resourceCount()).toBe(0);
    expect(closed).toBe(1);
    expect(removed.some((path) => path.endsWith('.part'))).toBe(true);
    database.close();
  });

  it('bounds simultaneously owned transfer tasks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-capacity-'));
    directories.push(directory);
    const source = join(directory, 'source.bin');
    await writeFile(source, Buffer.alloc(1));
    let releaseGrants!: () => void;
    const grantGate = new Promise<void>((resolve) => {
      releaseGrants = resolve;
    });
    const host = {
      resolveGrant: async () => {
        await grantGate;
        return {
          grantId: 'grant',
          kind: 'file',
          name: 'source.bin',
          permissions: ['read'],
          createdAt: new Date().toISOString(),
          path: source,
        };
      },
    };
    const database = await ProductDatabase.open();
    const service = new TransferService(
      { handle: vi.fn() } as never,
      host as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    const request = {
      connectionId: randomUUID(),
      direction: 'upload' as const,
      grantId: 'grant',
      remotePath: '/bounded.bin',
      recursive: false,
      conflict: 'overwrite' as const,
    };
    for (let index = 0; index < MAX_ACTIVE_TRANSFERS; index += 1)
      service.create(request, randomUUID());
    expect(service.resourceCount()).toBe(MAX_ACTIVE_TRANSFERS);
    expect(() => service.create(request, randomUUID())).toThrowError(
      expect.objectContaining({ code: 'TRANSFER_FAILED', status: 409 }),
    );
    releaseGrants();
    await service.closeAll();
    expect(service.resourceCount()).toBe(0);
    database.close();
  });

  it('reports a missing remote archive tool and cleans temporary remote entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-archive-transfer-'));
    directories.push(directory);
    const source = join(directory, 'folder');
    await mkdir(source);
    await writeFile(join(source, 'notes.txt'), 'archive payload');
    const files = new Map<string, Buffer>();
    const remoteDirectories = new Set<string>();
    const directoriesRemoved: string[] = [];
    const filesRemoved: string[] = [];
    let closed = 0;
    const sftp: SftpHandle = {
      realpath: async (path) => path,
      list: async () => [],
      stat: async () => {
        throw new Error('missing');
      },
      lstat: async (path) => {
        if (remoteDirectories.has(path))
          return {
            size: 0,
            mode: 0o040700,
            atime: 0,
            mtime: 0,
            uid: 0,
            gid: 0,
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
          };
        throw new Error('missing');
      },
      mkdir: async (path) => {
        remoteDirectories.add(path);
      },
      rename: async () => {},
      replace: async () => {},
      unlink: async (path) => {
        filesRemoved.push(path);
        files.delete(path);
      },
      rmdir: async (path) => {
        directoriesRemoved.push(path);
        remoteDirectories.delete(path);
      },
      chmod: async () => {},
      readStream: () => Readable.from([]),
      writeStream: (path) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
          final(callback) {
            files.set(path, Buffer.concat(chunks));
            callback();
          },
        });
      },
      close: async () => {
        closed += 1;
      },
    };
    const connections = {
      handle: () => ({
        openSftp: async () => sftp,
        exec: async () => ({ stdout: '', stderr: 'tar missing', exitCode: 127 }),
      }),
    };
    const host = {
      resolveGrant: async () => ({
        grantId: 'grant',
        kind: 'directory',
        name: 'folder',
        permissions: ['read'],
        createdAt: new Date().toISOString(),
        path: source,
      }),
    };
    const database = await ProductDatabase.open();
    const service = new TransferService(
      connections as never,
      host as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    const transfer = service.create(
      {
        connectionId: randomUUID(),
        direction: 'upload',
        grantId: 'grant',
        remotePath: '/folder',
        recursive: true,
        archive: true,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() =>
      expect(service.get(transfer.id)).toMatchObject({
        state: 'failed',
        errorCode: 'CAPABILITY_UNAVAILABLE',
      }),
    );
    expect(filesRemoved.some((path) => path.endsWith('.tar'))).toBe(true);
    expect(directoriesRemoved.some((path) => path.endsWith('.extract'))).toBe(true);
    expect(files.size).toBe(0);
    expect(closed).toBe(1);
    database.close();
  });

  it('streams files and recursive directories between same or different remote connections', async () => {
    const sourceStore = createRemoteStore(
      {
        '/source.txt': 'remote-source',
        '/tree/a.txt': 'alpha',
        '/tree/nested/b.txt': 'beta',
      },
      ['/tree', '/tree/nested'],
    );
    const targetStore = createRemoteStore({}, ['/dest']);
    const connectionA = randomUUID();
    const connectionB = randomUUID();
    const connections = {
      handle: (connectionId: string) => ({
        openSftp: async () =>
          (connectionId === connectionA ? sourceStore : targetStore).createHandle(),
      }),
    };
    const database = await ProductDatabase.open();
    const service = new TransferService(
      connections as never,
      undefined,
      new ProductRepository(database),
      new RealtimeHub(),
    );

    const crossServer = service.create(
      {
        direction: 'remote-copy',
        sourceConnectionId: connectionA,
        targetConnectionId: connectionB,
        sourcePath: '/source.txt',
        targetPath: '/dest/source.txt',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(crossServer.id).state).toBe('succeeded'));
    expect(targetStore.read('/dest/source.txt')).toBe('remote-source');
    expect(service.get(crossServer.id).bytesPerSecond).toBeGreaterThan(0);

    const sameServer = service.create(
      {
        direction: 'remote-copy',
        sourceConnectionId: connectionB,
        targetConnectionId: connectionB,
        sourcePath: '/dest/source.txt',
        targetPath: '/dest/source-copy.txt',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(sameServer.id).state).toBe('succeeded'));
    expect(targetStore.read('/dest/source-copy.txt')).toBe('remote-source');

    const recursive = service.create(
      {
        direction: 'remote-copy',
        sourceConnectionId: connectionA,
        targetConnectionId: connectionB,
        sourcePath: '/tree',
        targetPath: '/copied',
        recursive: true,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(recursive.id).state).toBe('succeeded'));
    expect(targetStore.read('/copied/a.txt')).toBe('alpha');
    expect(targetStore.read('/copied/nested/b.txt')).toBe('beta');

    const interactive = service.create(
      {
        direction: 'remote-copy',
        sourceConnectionId: connectionA,
        targetConnectionId: connectionB,
        sourcePath: '/tree',
        targetPath: '/copied',
        recursive: true,
        conflict: 'ask',
      },
      randomUUID(),
    );
    await vi.waitFor(() =>
      expect(service.get(interactive.id)).toMatchObject({
        state: 'awaiting-decision',
        conflict: { path: '/copied', type: 'directory' },
      }),
    );
    service.decideConflict(interactive.id, { strategy: 'overwrite', applyToAll: true });
    await vi.waitFor(() => expect(service.get(interactive.id).state).toBe('succeeded'));
    expect(targetStore.read('/copied/a.txt')).toBe('alpha');
    expect(sourceStore.closeCount).toBe(3);
    expect(targetStore.closeCount).toBe(5);
    expect(service.clearCompleted()).toBe(4);
    expect(service.list()).toEqual([]);
    database.close();
  });
});

function createRemoteStore(initialFiles: Record<string, string>, initialDirectories: string[]) {
  const files = new Map(
    Object.entries(initialFiles).map(([path, content]) => [path, Buffer.from(content)]),
  );
  const directories = new Set(['/', ...initialDirectories]);
  let closeCount = 0;
  const attributes = (path: string): SftpAttributes => {
    const file = files.get(path);
    if (file)
      return {
        size: file.length,
        mode: 0o100600,
        atime: 0,
        mtime: 0,
        uid: 0,
        gid: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    if (directories.has(path))
      return {
        size: 0,
        mode: 0o040700,
        atime: 0,
        mtime: 0,
        uid: 0,
        gid: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      };
    throw new Error(`missing ${path}`);
  };
  const createHandle = (): SftpHandle => ({
    realpath: async (path) => path,
    list: async (directory) => {
      const prefix = directory === '/' ? '/' : `${directory}/`;
      const names = new Set<string>();
      for (const path of [...directories, ...files.keys()]) {
        if (!path.startsWith(prefix) || path === directory) continue;
        const tail = path.slice(prefix.length);
        if (tail && !tail.includes('/')) names.add(tail);
      }
      return [...names].map((filename) => ({
        filename,
        attrs: attributes(posix.join(directory, filename)),
      }));
    },
    stat: async (path) => attributes(path),
    lstat: async (path) => attributes(path),
    mkdir: async (path) => {
      directories.add(path);
    },
    rename: async (from, to) => {
      const data = files.get(from);
      if (!data) throw new Error(`missing ${from}`);
      files.set(to, data);
      files.delete(from);
    },
    replace: async (from, to) => {
      const data = files.get(from);
      if (!data) throw new Error(`missing ${from}`);
      files.set(to, data);
      files.delete(from);
    },
    unlink: async (path) => {
      files.delete(path);
    },
    rmdir: async (path) => {
      directories.delete(path);
    },
    chmod: async () => {},
    readStream: (path) => Readable.from([files.get(path) ?? Buffer.alloc(0)]),
    writeStream: (path) => {
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
        final(callback) {
          files.set(path, Buffer.concat(chunks));
          callback();
        },
      });
    },
    close: async () => {
      closeCount += 1;
    },
  });
  return {
    createHandle,
    read: (path: string) => files.get(path)?.toString('utf8'),
    get closeCount() {
      return closeCount;
    },
  };
}
