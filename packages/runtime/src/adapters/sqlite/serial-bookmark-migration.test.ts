import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('Serial bookmark persistence', () => {
  it('survives migration 20 with the complete line configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-serial-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
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
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'serial',
        connectionDisplay: '/dev/tty.usbserial-fixture · 115200',
        serial: {
          baudRate: 115_200,
          rtscts: true,
          closeSequence: '\\x01ky',
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:20'")).toBeDefined();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
