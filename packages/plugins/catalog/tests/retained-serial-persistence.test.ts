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

describe('Serial bookmark persistence', () => {
  it('survives migration 20 with the complete line configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-serial-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await catalogStorage(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first.sql));
      service.createBookmark(
        {
          protocol: 'serial',
          hostId: null,
          title: '嵌入式控制台',
          serial: {
            path: '/dev/tty.usbserial-fixture',
            baudRate: 115_200,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            lock: true,
            rtscts: true,
            xon: false,
            xoff: false,
            xany: false,
            txLineEnding: '\r',
            rxLineEnding: 'none',
            closeSequence: '\\x01ky',
            closeSequenceDelayMs: 500,
            encoding: 'utf-8',
          },
        },
        service.snapshot().etag,
      );
      await first.close();

      const reopened = await catalogStorage(path);
      const bookmark = new BookmarkRepository(reopened.sql).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'serial',
        connectionDisplay: '/dev/tty.usbserial-fixture · 115200',
        serial: {
          baudRate: 115_200,
          rtscts: true,
          closeSequence: '\\x01ky',
        },
      });
      expect(await readMigrationMarker(path, 20)).toBeDefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
