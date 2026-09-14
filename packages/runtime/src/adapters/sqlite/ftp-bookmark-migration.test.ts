import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('FTP bookmark persistence', () => {
  it('survives restart with only an opaque application-local credential reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ftp-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
      service.createBookmark(
        {
          protocol: 'ftp',
          hostId: null,
          title: 'FTP 发布',
          ftp: {
            hostname: 'ftp.example.test',
            port: 990,
            username: 'publisher',
            credentialRef: 'local-credential-ref',
            security: 'implicit-tls',
            tlsVerify: true,
            encoding: 'gb18030',
            initialDirectory: '/release',
          },
        },
        service.snapshot().etag,
      );
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'ftp',
        connectionDisplay: 'publisher@ftp.example.test:990',
        ftp: {
          credentialRef: 'local-credential-ref',
          security: 'implicit-tls',
          encoding: 'gb18030',
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:18'")).toBeDefined();
      reopened.close();
      expect((await readFile(path)).includes(Buffer.from('plain-secret-never-persisted'))).toBe(
        false,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
