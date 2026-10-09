import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('VNC bookmark persistence', () => {
  it('survives migration 22 with credentials, route and display settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-vnc-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
      service.createBookmark(
        {
          protocol: 'vnc',
          hostId: null,
          title: 'Linux visual host',
          vnc: {
            hostname: 'vnc.example.test',
            port: 5_901,
            username: 'designer',
            credentialRef: 'local-vnc-ref',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 22_000,
            viewOnly: true,
            clipViewport: true,
            scaleViewport: false,
            qualityLevel: 8,
            compressionLevel: 6,
            shared: false,
            showDotCursor: false,
            clipboard: false,
          },
        },
        service.snapshot().etag,
      );
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'vnc',
        connectionDisplay: 'designer@vnc.example.test:5901',
        vnc: {
          credentialRef: 'local-vnc-ref',
          viewOnly: true,
          clipViewport: true,
          scaleViewport: false,
          qualityLevel: 8,
          compressionLevel: 6,
          shared: false,
          showDotCursor: false,
          clipboard: false,
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:22'")).toBeDefined();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
