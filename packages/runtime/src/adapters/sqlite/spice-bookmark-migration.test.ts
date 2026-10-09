import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('SPICE bookmark persistence', () => {
  it('survives migration 23 with credential, route and viewport settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-spice-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
      service.createBookmark(
        {
          protocol: 'spice',
          hostId: null,
          title: 'SPICE visual host',
          connectionProfileId: null,
          spice: {
            hostname: 'spice.example.test',
            port: 5_901,
            credentialRef: 'local-spice-ref',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 22_000,
            viewOnly: true,
            scaleViewport: false,
          },
        },
        service.snapshot().etag,
      );
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'spice',
        connectionDisplay: 'spice.example.test:5901',
        spice: {
          credentialRef: 'local-spice-ref',
          proxy: { mode: 'direct' },
          connectionTimeoutMs: 22_000,
          viewOnly: true,
          scaleViewport: false,
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:23'")).toBeDefined();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
