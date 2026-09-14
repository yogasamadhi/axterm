import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import type { FtpFileHandle, FtpTransport } from '../ports/ftp-transport';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { FtpConnectionService } from './ftp-connection-service';

function handleFixture(): FtpFileHandle {
  return {
    pwd: vi.fn(async () => '/'),
    cd: vi.fn(async () => {}),
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
      bookmarks,
      profiles,
      { resolveCredential } as never,
      transport,
    );
    const bookmark = createdTree.bookmarks[0]!;
    const metadata = await service.create(bookmark.id);
    expect(metadata).toMatchObject({ state: 'ready', security: 'explicit-tls' });
    expect(JSON.stringify(metadata)).not.toContain('plain-secret');
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'plain-secret' }));

    const operation = await service.openFiles(metadata.id);
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(service.resourceCount()).toBe(2);
    await operation.close();
    await service.close(metadata.id);
    expect(service.get(metadata.id).state).toBe('closed');
    database.close();
  });
});
