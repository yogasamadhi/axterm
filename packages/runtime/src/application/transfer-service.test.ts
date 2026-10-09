import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import {
  SftpCapabilityUnavailableError,
  type SftpAttributes,
  type SftpHandle,
} from '../ports/ssh-transport';
import { RealtimeHub } from './realtime-hub';
import { MAX_ACTIVE_TRANSFERS, MAX_RETRY_TRANSFERS, TransferService } from './transfer-service';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('TransferService', () => {
  it('revalidates grants on retry and consumes the failed request only once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-retry-'));
    directories.push(directory);
    const source = join(directory, 'payload.txt');
    await writeFile(source, 'retry byte evidence');
    const remote = createRemoteStore({}, []);
    let granted = false;
    let ready = true;
    const resolveGrant = vi.fn(async () => {
      if (!granted) throw new Error('File grant expired');
      return { path: source, permissions: ['read'] };
    });
    const connections = {
      get: () => ({ state: ready ? 'ready' : 'closed' }),
      handle: () => ({ onClose: () => () => {}, openSftp: remote.createHandle }),
    };
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const service = new TransferService(
      connections as never,
      { resolveGrant } as never,
      repository,
      new RealtimeHub(),
    );
    try {
      const transfer = service.create(
        {
          connectionId: randomUUID(),
          direction: 'upload',
          grantId: 'ephemeral-grant',
          remotePath: '/payload.txt',
          recursive: false,
          conflict: 'overwrite',
        },
        randomUUID(),
      );
      await vi.waitFor(() =>
        expect(service.get(transfer.id)).toMatchObject({
          state: 'failed',
          retryAvailability: 'available',
        }),
      );
      expect(repository.getTransfer(transfer.id)).not.toHaveProperty('retryAvailability');
      ready = false;
      expect(service.get(transfer.id).retryAvailability).toBe('connection-unavailable');
      expect(() => service.retry(transfer.id)).toThrowError(
        expect.objectContaining({
          code: 'INVALID_STATE',
          status: 409,
        }),
      );
      expect(resolveGrant).toHaveBeenCalledOnce();
      ready = true;
      granted = true;
      const retry = service.retry(transfer.id);
      expect(retry.id).not.toBe(transfer.id);
      expect(service.get(transfer.id).retryAvailability).toBe('request-expired');
      expect(() => service.retry(transfer.id)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
      expect(() => service.retry(retry.id)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
      await vi.waitFor(() => expect(service.get(retry.id).state).toBe('succeeded'));
      expect(remote.read('/payload.txt')).toBe('retry byte evidence');
      expect(resolveGrant).toHaveBeenCalledTimes(2);
      expect(service.get(retry.id).retryAvailability).toBe('not-terminal');
      const restarted = new TransferService(
        connections as never,
        { resolveGrant } as never,
        repository,
        new RealtimeHub(),
      );
      expect(restarted.get(transfer.id).retryAvailability).toBe('request-expired');
      expect(() => restarted.retry(transfer.id)).toThrowError(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
      expect(service.clearCompleted()).toBe(2);
      expect(service.list()).toEqual([]);
      expect(() => service.retry(retry.id)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
    } finally {
      await service.closeAll();
      database.close();
    }
  });

  it('bounds retained retry requests and drops them on shutdown', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const connections = { get: () => ({ state: 'ready' }) };
    const service = new TransferService(
      connections as never,
      {
        resolveGrant: async () => {
          throw new Error('Revoked grant');
        },
      } as never,
      repository,
      new RealtimeHub(),
    );
    try {
      const ids: string[] = [];
      for (let index = 0; index <= MAX_RETRY_TRANSFERS; index += 1) {
        const transfer = service.create(
          {
            connectionId: randomUUID(),
            direction: 'upload',
            grantId: 'grant',
            remotePath: '/payload.txt',
            recursive: false,
            conflict: 'overwrite',
          },
          randomUUID(),
        );
        ids.push(transfer.id);
        await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('failed'), {
          interval: 1,
        });
      }
      expect(service.get(ids[0]!).retryAvailability).toBe('request-expired');
      expect(
        service.list().filter(({ retryAvailability }) => retryAvailability === 'available'),
      ).toHaveLength(MAX_RETRY_TRANSFERS);
      expect(service.get(ids.at(-1)!).retryAvailability).toBe('available');
      await service.closeAll();
      expect(service.resourceCount()).toBe(0);
      expect(
        service.list().every(({ retryAvailability }) => retryAvailability === 'request-expired'),
      ).toBe(true);
    } finally {
      await service.closeAll();
      database.close();
    }
  });

  it('checks both remote-copy connections and FTP readiness before advertising retry', async () => {
    const database = await ProductDatabase.open();
    let targetReady = false;
    let ftpReady = false;
    const source = randomUUID();
    const target = randomUUID();
    const connections = {
      get: (id: string) => ({ state: id === source || targetReady ? 'ready' : 'closed' }),
    };
    const service = new TransferService(
      connections as never,
      undefined,
      new ProductRepository(database),
      new RealtimeHub(),
      {
        get: () => ({ state: ftpReady ? 'ready' : 'closed' }),
      } as never,
    );
    try {
      const copy = service.create(
        {
          direction: 'remote-copy',
          sourceConnectionId: source,
          targetConnectionId: target,
          sourcePath: '/a',
          targetPath: '/b',
          recursive: false,
          conflict: 'overwrite',
        },
        randomUUID(),
      );
      const ftp = service.create(
        {
          direction: 'download',
          protocol: 'ftp',
          connectionId: randomUUID(),
          grantId: 'grant',
          remotePath: '/a',
          recursive: false,
          conflict: 'overwrite',
        },
        randomUUID(),
      );
      await vi.waitFor(() => expect(service.get(copy.id).state).toBe('failed'));
      await vi.waitFor(() => expect(service.get(ftp.id).state).toBe('failed'));
      expect(service.get(copy.id).retryAvailability).toBe('connection-unavailable');
      expect(service.get(ftp.id).retryAvailability).toBe('connection-unavailable');
      targetReady = true;
      ftpReady = true;
      expect(service.get(copy.id).retryAvailability).toBe('available');
      expect(service.get(ftp.id).retryAvailability).toBe('available');
      service.clearCompleted();
      expect(service.list()).toEqual([]);
    } finally {
      await service.closeAll();
      database.close();
    }
  });

  it('preserves original bytes and removes staging files when atomic remote overwrite is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-atomic-'));
    directories.push(directory);
    const source = join(directory, 'source.txt');
    await writeFile(source, 'replacement');
    const remote = createRemoteStore({ '/target.txt': 'original' }, []);
    const closed = vi.fn(async () => {});
    const handle = remote.createHandle();
    handle.replace = async () => {
      throw new SftpCapabilityUnavailableError('atomic-replace');
    };
    handle.close = closed;
    const database = await ProductDatabase.open();
    const service = new TransferService(
      {
        get: () => ({ state: 'ready' }),
        handle: () => ({ onClose: () => () => {}, openSftp: async () => handle }),
      } as never,
      { resolveGrant: async () => ({ path: source, permissions: ['read'] }) } as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    try {
      const transfer = service.create(
        {
          direction: 'upload',
          connectionId: randomUUID(),
          grantId: 'grant',
          remotePath: '/target.txt',
          recursive: false,
          conflict: 'ask',
        },
        randomUUID(),
      );
      await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('awaiting-decision'));
      expect(remote.read('/target.txt')).toBe('original');
      service.decideConflict(transfer.id, { strategy: 'overwrite', applyToAll: false });
      await vi.waitFor(() =>
        expect(service.get(transfer.id)).toMatchObject({
          state: 'failed',
          errorCode: 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE',
          retryAvailability: 'available',
        }),
      );
      expect(remote.read('/target.txt')).toBe('original');
      expect((await handle.list('/')).map(({ filename }) => filename)).toEqual(['target.txt']);
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      await service.closeAll();
      database.close();
    }
  });

  it('settles owned streams before closing the SFTP channel after a pooled job fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-pool-'));
    directories.push(directory);
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
      await writeFile(join(directory, name), name);
    const remote = createRemoteStore({}, []);
    const handle = remote.createHandle();
    const events: string[] = [];
    let writing = 0;
    let releaseWrites!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const writes: string[] = [];
    handle.writeStream = (path) => {
      writes.push(path);
      const failThisStream = writes.length === 1;
      writing += 1;
      let retained = true;
      return new Writable({
        write(_chunk, _encoding, callback) {
          if (failThisStream) callback(new Error('Injected stream failure'));
          else void held.then(() => callback());
        },
        destroy(error, callback) {
          if (retained) {
            writing -= 1;
            retained = false;
            events.push('stream closed');
          }
          callback(error);
        },
      });
    };
    handle.close = async () => {
      expect(writing).toBe(0);
      events.push('channel closed');
    };
    const database = await ProductDatabase.open();
    const service = new TransferService(
      { handle: () => ({ onClose: () => () => {}, openSftp: async () => handle }) } as never,
      {
        resolveGrant: async () => ({ path: directory, kind: 'directory', permissions: ['read'] }),
      } as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    try {
      const transfer = service.create(
        {
          direction: 'upload',
          connectionId: randomUUID(),
          grantId: 'grant',
          remotePath: '/folder',
          recursive: true,
          conflict: 'overwrite',
        },
        randomUUID(),
      );
      await vi.waitFor(() => expect(writes.length).toBe(4));
      expect(events).not.toContain('channel closed');
      expect(service.resourceCount()).toBe(1);
      releaseWrites();
      await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('failed'));
      expect(writes).toHaveLength(4);
      expect(events.at(-1)).toBe('channel closed');
      expect(service.resourceCount()).toBe(0);
    } finally {
      releaseWrites();
      await service.closeAll();
      database.close();
    }
  });

  it('recovers every interrupted transfer state without reviving requests or grants', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const states = [
      'queued',
      'preparing',
      'running',
      'paused',
      'awaiting-decision',
      'succeeded',
      'failed',
      'canceled',
    ] as const;
    const rows = states.map((state) => ({
      id: randomUUID(),
      connectionId: randomUUID(),
      direction: 'download' as const,
      state,
      source: '/remote.txt',
      destination: '/authorized/remote.txt',
      bytesTransferred: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    rows.forEach((row) => repository.saveTransfer(row));
    try {
      repository.recoverInterruptedWork();
      const restarted = new TransferService(
        { get: () => ({ state: 'ready' }) } as never,
        undefined,
        repository,
        new RealtimeHub(),
      );
      for (const row of rows.slice(0, 5)) {
        expect(restarted.get(row.id)).toMatchObject({
          state: 'failed',
          errorCode: 'RUNTIME_INTERRUPTED',
          retryAvailability: 'request-expired',
        });
        expect(() => restarted.retry(row.id)).toThrowError(
          expect.objectContaining({ code: 'INVALID_STATE' }),
        );
      }
      for (const row of rows.slice(5)) expect(restarted.get(row.id).state).toBe(row.state);
      expect(restarted.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('fails a waiting conflict on SSH disconnect and releases its connection subscription', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-disconnect-'));
    directories.push(directory);
    const source = join(directory, 'payload.txt');
    await writeFile(source, 'replacement');
    const remote = createRemoteStore({ '/target.txt': 'original' }, []);
    const listeners = new Set<() => void>();
    const release = vi.fn((listener: () => void) => listeners.delete(listener));
    let ready = true;
    const database = await ProductDatabase.open();
    const service = new TransferService(
      {
        get: () => ({ state: ready ? 'ready' : 'closed' }),
        handle: () => ({
          openSftp: remote.createHandle,
          onClose: (listener: () => void) => {
            listeners.add(listener);
            return () => {
              release(listener);
            };
          },
        }),
      } as never,
      { resolveGrant: async () => ({ path: source, permissions: ['read'] }) } as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );
    try {
      const transfer = service.create(
        {
          direction: 'upload',
          connectionId: randomUUID(),
          grantId: 'grant',
          remotePath: '/target.txt',
          recursive: false,
          conflict: 'ask',
        },
        randomUUID(),
      );
      await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('awaiting-decision'));
      expect(listeners.size).toBe(1);
      ready = false;
      [...listeners].forEach((notify) => notify());
      await vi.waitFor(() =>
        expect(service.get(transfer.id)).toMatchObject({
          state: 'failed',
          errorCode: 'TRANSFER_FAILED',
          retryAvailability: 'connection-unavailable',
        }),
      );
      expect(service.resourceCount()).toBe(0);
      expect(release).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
      expect(remote.closeCount).toBe(1);
      expect(remote.read('/target.txt')).toBe('original');
    } finally {
      await service.closeAll();
      database.close();
    }
  });

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

  it('writes downloads to an explicit relative path inside the granted directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-download-transfer-'));
    directories.push(directory);
    const localTarget = join(directory, 'left-pane', 'active-directory', 'remote.txt');
    const remote = createRemoteStore({ '/remote.txt': 'download payload' }, []);
    const resolveGrantTransferPath = vi.fn(async () => ({
      grantId: 'left-pane-grant',
      kind: 'directory' as const,
      name: 'left-pane',
      permissions: ['read', 'write'],
      createdAt: new Date().toISOString(),
      path: localTarget,
    }));
    const database = await ProductDatabase.open();
    const service = new TransferService(
      { handle: () => ({ onClose: () => () => {}, openSftp: remote.createHandle }) } as never,
      { resolveGrantTransferPath } as never,
      new ProductRepository(database),
      new RealtimeHub(),
    );

    const transfer = service.create(
      {
        connectionId: randomUUID(),
        direction: 'download',
        grantId: 'left-pane-grant',
        localPath: 'active-directory/remote.txt',
        remotePath: '/remote.txt',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );

    await vi.waitFor(() => expect(service.get(transfer.id).state).toBe('succeeded'));
    expect(resolveGrantTransferPath).toHaveBeenCalledWith(
      'left-pane-grant',
      'active-directory/remote.txt',
      'write-target',
    );
    expect(await readFile(localTarget, 'utf8')).toBe('download payload');
    expect(service.get(transfer.id).destination).toBe(localTarget);
    expect(JSON.stringify(service.get(transfer.id))).not.toContain('left-pane-grant');
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
    const connections = { handle: () => ({ onClose: () => () => {}, openSftp: async () => sftp }) };
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
    const pausedShutdown = service.create(
      {
        connectionId: randomUUID(),
        direction: 'upload',
        grantId: 'grant',
        remotePath: '/paused-shutdown.bin',
        recursive: false,
        conflict: 'overwrite',
      },
      randomUUID(),
    );
    await vi.waitFor(() => expect(service.get(pausedShutdown.id).state).toBe('running'));
    service.pause(pausedShutdown.id);
    await service.closeAll();
    expect(service.get(pausedShutdown.id)).toMatchObject({
      state: 'canceled',
      retryAvailability: 'request-expired',
    });
    expect(service.resourceCount()).toBe(0);
    expect(closed).toBe(2);
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
      { handle: vi.fn(() => ({ onClose: () => () => {} })) } as never,
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
        onClose: () => () => {},
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
        onClose: () => () => {},
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
