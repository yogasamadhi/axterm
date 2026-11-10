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

describe('RDP bookmark persistence', () => {
  it('survives migration 21 with credentials, route and viewport settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-rdp-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
      service.createBookmark(
        {
          protocol: 'rdp',
          hostId: null,
          title: 'Windows build host',
          rdp: {
            hostname: 'win.example.test',
            port: 3_390,
            username: 'builder',
            credentialRef: 'local-rdp-ref',
            domain: 'LAB',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 22_000,
            desktopWidth: 1_440,
            desktopHeight: 900,
            scaleViewport: true,
            clipboard: true,
          },
        },
        service.snapshot().etag,
      );
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'rdp',
        connectionDisplay: 'builder@win.example.test:3390',
        rdp: {
          credentialRef: 'local-rdp-ref',
          domain: 'LAB',
          desktopWidth: 1_440,
          desktopHeight: 900,
          scaleViewport: true,
        },
      });
      expect(await readMigrationMarker(path, 21)).toBeDefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
