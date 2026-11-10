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

describe('VNC bookmark persistence', () => {
  it('survives migration 22 with credentials, route and display settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-vnc-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
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
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
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
      expect(await readMigrationMarker(path, 22)).toBeDefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
