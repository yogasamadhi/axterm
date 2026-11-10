import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../src/application/bookmark-tree-service.ts';
import { BookmarkRepository } from '../src/adapters/bookmark-repository.ts';
import {
  catalogStorage,
  readMigrationMarker,
} from '../../../../tests/fixtures/level3-catalog-storage.ts';

describe('FTP bookmark persistence', () => {
  it('survives restart with only an opaque application-local credential reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-ftp-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
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
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'ftp',
        connectionDisplay: 'publisher@ftp.example.test:990',
        ftp: {
          credentialRef: 'local-credential-ref',
          security: 'implicit-tls',
          encoding: 'gb18030',
        },
      });
      expect(await readMigrationMarker(path, 18)).toBeDefined();
      await reopened.close();
      expect((await readFile(path)).includes(Buffer.from('plain-secret-never-persisted'))).toBe(
        false,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
