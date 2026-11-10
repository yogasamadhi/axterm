import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bookmarkSchema, createBookmarkSchema, type Bookmark } from '@axterm/plugin-api/catalog';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import { PlainTerminals } from '../../packages/plugins/connections/src/application/plain-terminals.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import type {
  SerialOpenInput,
  SerialTransport,
} from '../../packages/plugins/connections/src/ports/serial-transport.ts';
describe('SerialService', () => {
  it('opens a Bookmark through the transport and registers deterministic terminal ownership', async () => {
    let selected: Bookmark;
    const bookmarks = {
      createBookmark(input: unknown, _etag: string) {
        const now = new Date().toISOString();
        selected = bookmarkSchema.parse({
          ...createBookmarkSchema.parse(input),
          id: randomUUID(),
          position: 0,
          connectionDisplay: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        return { bookmarks: [selected] };
      },
      snapshot: () => ({ etag: '"fixture"' }),
      getBookmark: () => selected,
      getConnectionProfile: () => {
        throw Error('No profile selected');
      },
    };
    let service: PlainTerminals | undefined;
    let terminals: TerminalService | undefined;
    try {
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
      terminals = new TerminalService(
        {
          open: () => {
            throw new Error('PTY must not be used for Serial');
          },
        },
        {
          open: async () => {
            throw Error('No recording requested');
          },
        },
      );
      const owner = terminals;
      service = new PlainTerminals(
        bookmarks,
        {
          resolveCredential: async () => {
            throw Error('Serial has no credentials');
          },
        },
        transport,
        {
          connect: async () => {
            throw Error('Serial cannot use Telnet');
          },
        },
        {
          registerExternal: (metadata, channel, integration) =>
            owner.registerExternal({ ...metadata, id: randomUUID() }, channel, integration),
          close: (id) => owner.close(id),
        },
      );
      await expect(service.listPorts()).resolves.toEqual([{ path: '/dev/tty.fixture' }]);
      const session = await service.open({
        kind: 'serial',
        bookmarkId: tree.bookmarks[0]!.id,
        cols: 80,
        rows: 24,
      });
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
      await service?.close();
      await terminals?.dispose();
    }
  });
});
