import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('RDP bookmark persistence', () => {
  it('survives migration 21 with credentials, route and viewport settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-rdp-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
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
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
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
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:21'")).toBeDefined();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
