import { describe, expect, it, vi } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import type { TerminalChannel } from '../ports/terminal-channel';
import type { SerialOpenInput, SerialTransport } from '../ports/serial-transport';
import { BookmarkTreeService } from './bookmark-tree-service';
import { SerialService } from './serial-service';
import { TerminalService } from './terminal-service';

describe('SerialService', () => {
  it('opens a Bookmark through the transport and registers deterministic terminal ownership', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const tree = bookmarks.createBookmark(
        {
          protocol: 'serial',
          hostId: null,
          title: 'MCU console',
          serial: {
            path: '/dev/tty.fixture',
            baudRate: 57_600,
            dataBits: 7,
            stopBits: 2,
            parity: 'even',
            lock: true,
            rtscts: false,
            xon: true,
            xoff: true,
            xany: false,
            txLineEnding: '\r\n',
            rxLineEnding: 'lf_to_crlf',
            closeSequence: '',
            closeSequenceDelayMs: 0,
            encoding: 'gbk',
          },
        },
        bookmarks.snapshot().etag,
      );
      const close = vi.fn(async () => {});
      const channel: TerminalChannel = {
        shellIntegrationKind: 'unsupported',
        write: vi.fn(),
        resize: vi.fn(),
        signal: vi.fn(),
        onData: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        pause: vi.fn(),
        resume: vi.fn(),
        close,
      };
      let opened: SerialOpenInput | undefined;
      const transport: SerialTransport = {
        list: vi.fn(async () => [{ path: '/dev/tty.fixture' }]),
        open: vi.fn(async (input) => {
          opened = input;
          return channel;
        }),
      };
      const terminals = new TerminalService({
        open: () => {
          throw new Error('PTY must not be used for Serial');
        },
      });
      const service = new SerialService(bookmarks, transport, terminals);
      await expect(service.listPorts()).resolves.toEqual([{ path: '/dev/tty.fixture' }]);
      const session = await service.open({ bookmarkId: tree.bookmarks[0]!.id });
      expect(opened).toMatchObject({
        path: '/dev/tty.fixture',
        baudRate: 57_600,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        txLineEnding: '\r\n',
        rxLineEnding: 'lf_to_crlf',
      });
      expect(session).toMatchObject({
        kind: 'serial',
        title: 'MCU console',
        bookmarkId: tree.bookmarks[0]!.id,
        behavior: { encoding: 'gbk' },
      });
      expect(terminals.resourceCount()).toBe(1);
      await terminals.close(session.id);
      expect(close).toHaveBeenCalledOnce();
      expect(terminals.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});
