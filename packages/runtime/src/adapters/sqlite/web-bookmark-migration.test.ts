import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('Web bookmark persistence', () => {
  it('survives migration 24 with URL, User-Agent and address bar settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-web-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
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
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'web',
        connectionDisplay: 'https://dashboard.example.test/console',
        web: {
          url: 'https://dashboard.example.test/console',
          userAgent: 'Axterm-Web-Test/1.0',
          hideAddressBar: true,
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:24'")).toBeDefined();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
