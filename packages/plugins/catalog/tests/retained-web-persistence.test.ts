import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../src/application/bookmark-tree-service.ts';
import { BookmarkRepository } from '../src/adapters/bookmark-repository.ts';
import {
  catalogStorage,
  readMigrationMarker,
} from '../../../../tests/fixtures/level3-catalog-storage.ts';

describe('Web bookmark persistence', () => {
  it('survives migration 24 with URL, User-Agent and address bar settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-web-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
      service.createBookmark(
        {
          protocol: 'web',
          hostId: null,
          title: 'Operations dashboard',
          connectionProfileId: null,
          web: {
            url: 'https://dashboard.example.test/console',
            userAgent: 'Axterm-Web-Test/1.0',
            hideAddressBar: true,
          },
        },
        service.snapshot().etag,
      );
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'web',
        connectionDisplay: 'https://dashboard.example.test/console',
        web: {
          url: 'https://dashboard.example.test/console',
          userAgent: 'Axterm-Web-Test/1.0',
          hideAddressBar: true,
        },
      });
      expect(await readMigrationMarker(path, 24)).toBeDefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
