import { OwnedFileLease } from '../../packages/plugins/connections/src/adapters/file-lease.ts';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionFactsFixture as ProductDatabase } from '../fixtures/level3-connection-facts.ts';
import { BookmarkRepository } from '../../packages/plugins/catalog/src/adapters/bookmark-repository.ts';
import { ConnectionProfileRepository } from '../../packages/plugins/catalog/src/adapters/connection-profile-repository.ts';
import type {
  FtpFileHandle,
  FtpTransport,
} from '../../packages/plugins/connections/src/ports/ftp-transport.ts';
import { BookmarkTreeService } from '../../packages/plugins/catalog/src/application/bookmark-tree-service.ts';
import { ConnectionProfileService } from '../../packages/plugins/catalog/src/application/connection-profile-service.ts';
import { FtpConnectionService } from '../../packages/plugins/connections/src/application/ftp-connection-service.ts';

function handleFixture(): FtpFileHandle {
  return {
    pwd: vi.fn(async () => '/'),
    cd: vi.fn(async () => {}),
    realpath: vi.fn(async (path) => path),
    list: vi.fn(async () => []),
    stat: vi.fn(async () => ({
      size: 0,
      mode: 0o755,
      atime: 0,
      mtime: 0,
      uid: 0,
      gid: 0,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    })),
    lstat: vi.fn(async () => ({
      size: 0,
      mode: 0o755,
      atime: 0,
      mtime: 0,
      uid: 0,
      gid: 0,
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
    })),
    mkdir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    replace: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    rmdir: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    readStream: () => Readable.from([]),
    writeStream: () =>
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    close: vi.fn(async () => {}),
  };
}

describe('FtpConnectionService', () => {
  it('resolves a local credential for each operation and never returns the secret', async () => {
    const database = await ProductDatabase.open();
    const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
    const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
    const createdTree = bookmarks.createBookmark(
      {
        protocol: 'ftp',
        hostId: null,
        title: '发布服务器',
        ftp: {
          hostname: 'ftp.example.test',
          port: 21,
          username: 'operator',
          credentialRef: 'local-vault-ref',
          security: 'explicit-tls',
          tlsVerify: true,
          encoding: 'utf-8',
          initialDirectory: '/uploads',
        },
      },
      bookmarks.snapshot().etag,
    );
    const connect = vi.fn(async () => handleFixture());
    const transport: FtpTransport = { connect };
    const resolveCredential = vi.fn(async () => 'plain-secret');
    const service = new FtpConnectionService(
      {
        getBookmark: (id) => bookmarks.getBookmark(id),
        getConnectionProfile: (id) => profiles.get(id),
      },
      { resolveCredential } as never,
      transport,
      (native, signal, released) => new OwnedFileLease(native, signal, released),
      () => {},
    );
    const bookmark = createdTree.bookmarks[0]!;
    const allocated = vi.fn((id: string) => {
      expect(service.get(id).state).toBe('connecting');
      expect(connect).not.toHaveBeenCalled();
    });
    const metadata = await service.create(bookmark.id, undefined, allocated);
    expect(allocated).toHaveBeenCalledExactlyOnceWith(metadata.id);
    expect(metadata).toMatchObject({ state: 'ready', security: 'explicit-tls' });
    expect(JSON.stringify(metadata)).not.toContain('plain-secret');
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'plain-secret' }));

    const operation = await service.openFiles(metadata.id);
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(service.resourceCount()).toBe(2);
    await operation.close();
    await service.close(metadata.id);
    expect(service.get(metadata.id).state).toBe('closed');
    await database.close();
  });
});

async function controlled(transport: FtpTransport) {
  const database = await ProductDatabase.open();
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const tree = bookmarks.createBookmark(
    {
      protocol: 'ftp',
      hostId: null,
      title: 'Lifecycle fixture',
      ftp: {
        hostname: 'ftp.example.test',
        port: 21,
        username: 'fixture',
        credentialRef: null,
        security: 'plain',
        tlsVerify: true,
        encoding: 'utf-8',
        initialDirectory: '/',
      },
    },
    bookmarks.snapshot().etag,
  );
  const changed = vi.fn();
  const service = new FtpConnectionService(
    {
      getBookmark: (id) => bookmarks.getBookmark(id),
      getConnectionProfile: (id) => profiles.get(id),
    },
    {
      resolveCredential: async () => {
        throw new Error('unused');
      },
    },
    transport,
    (native, signal, released) => new OwnedFileLease(native, signal, released),
    changed,
  );
  return { database, service, bookmark: tree.bookmarks[0]!, changed };
}

it('waits for a canceled late FTP connect and its actual close before session shutdown returns', async () => {
  const opened = Promise.withResolvers<FtpFileHandle>();
  const closed = Promise.withResolvers<void>();
  const native = handleFixture();
  native.close = vi.fn(() => closed.promise);
  const connect = vi.fn(() => opened.promise);
  const { service, database, bookmark } = await controlled({ connect });
  try {
    const creation = service.create(bookmark.id);
    const rejected = expect(creation).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const id = service.list()[0]!.id;
    const finished = vi.fn();
    const closing = service.close(id).then(finished);
    expect(connect.mock.calls).toHaveLength(1);
    opened.resolve(native);
    await vi.waitFor(() => expect(native.close).toHaveBeenCalledOnce());
    expect(finished).not.toHaveBeenCalled();
    closed.resolve();
    await rejected;
    await closing;
    expect(service.activeTaskCount()).toBe(0);
    expect(service.resourceCount()).toBe(0);
  } finally {
    opened.resolve(native);
    closed.resolve();
    await service.closeAll();
    await database.close();
  }
});

it('aborts and joins an admitted FTP file lease during concurrent close/unload', async () => {
  const native = handleFixture();
  const { service, database, bookmark } = await controlled({ connect: async () => native });
  try {
    const created = await service.create(bookmark.id);
    const lease = await service.openFiles(created.id);
    expect(lease.signal.aborted).toBe(false);
    const closing = service.close(created.id);
    expect(service.close(created.id)).toBe(closing);
    await Promise.all([closing, service.closeAll()]);
    expect(lease.signal.aborted).toBe(true);
    expect(service.resourceCount()).toBe(0);
    await expect(lease.filesystem.list('/')).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    await expect(service.create(bookmark.id)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  } finally {
    await service.closeAll();
    await database.close();
  }
});

it('keeps failed FTP cleanup active and never reports a false closed session', async () => {
  let fail = false;
  const native = handleFixture();
  native.close = vi.fn(async () => {
    if (fail) throw new Error('controlled close failure');
  });
  const { service, database, bookmark } = await controlled({ connect: async () => native });
  try {
    const created = await service.create(bookmark.id);
    await service.openFiles(created.id);
    fail = true;
    await expect(service.close(created.id)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
    expect(service.get(created.id).state).toBe('closing');
    expect(service.activeTaskCount()).toBeGreaterThan(0);
    await expect(service.closeAll()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  } finally {
    await database.close();
  }
});

it('does not start FTP IO or retain an unbound logical resource when command association is rejected', async () => {
  const connect = vi.fn(async () => handleFixture()),
    f = await controlled({ connect });
  try {
    await expect(
      f.service.create(f.bookmark.id, undefined, () => {
        throw Error('BINDING_REJECTED');
      }),
    ).rejects.toThrow('BINDING_REJECTED');
    expect(connect).not.toHaveBeenCalled();
    expect(f.service.list()).toEqual([]);
    expect(f.service.resourceCount()).toBe(0);
  } finally {
    await f.service.closeAll();
    await f.database.close();
  }
});
