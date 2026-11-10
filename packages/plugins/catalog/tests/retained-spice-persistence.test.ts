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

describe('SPICE bookmark persistence', () => {
  it('survives migration 23 with credential, route and viewport settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-spice-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
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
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
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
      expect(await readMigrationMarker(path, 23)).toBeDefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
