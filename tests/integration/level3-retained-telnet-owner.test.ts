import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bookmarkSchema, createBookmarkSchema, type Bookmark } from '@axterm/plugin-api/catalog';
import type { TerminalChannel } from '@axterm/plugin-api/host';
import { PlainTerminals } from '../../packages/plugins/connections/src/application/plain-terminals.ts';
import { TerminalService } from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import type {
  TelnetConnectInput,
  TelnetTransport,
} from '../../packages/plugins/connections/src/ports/telnet-transport.ts';
describe('TelnetService', () => {
  it('resolves the local credential, omits it from metadata and owns channel cleanup', async () => {
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
          protocol: 'telnet',
          hostId: null,
          title: 'Legacy router',
          telnet: {
            hostname: 'router.example.test',
            port: 2323,
            username: 'operator',
            credentialRef: 'local-telnet-ref',
            loginPrompt: '/login[: ]*$/i',
            passwordPrompt: '/password[: ]*$/i',
            encoding: 'gb18030',
            connectionTimeoutMs: 5_000,
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
      let connectInput: TelnetConnectInput | undefined;
      const transport: TelnetTransport = {
        connect: vi.fn(async (input) => {
          connectInput = input;
          return channel;
        }),
      };
      const resolveCredential = vi.fn(async () => 'plain-telnet-password');
      terminals = new TerminalService(
        {
          open: () => {
            throw new Error('PTY must not be used for Telnet');
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
        { resolveCredential },
        {
          list: async () => [],
          open: async () => {
            throw Error('Telnet cannot use Serial');
          },
        },
        transport,
        {
          registerExternal: (metadata, channel, integration) =>
            owner.registerExternal({ ...metadata, id: randomUUID() }, channel, integration),
          close: (id) => owner.close(id),
        },
      );

      const session = await service.open({
        kind: 'telnet',
        bookmarkId: tree.bookmarks[0]!.id,
        cols: 120,
        rows: 40,
      });
      expect(connectInput).toMatchObject({
        host: 'router.example.test',
        port: 2323,
        username: 'operator',
        password: 'plain-telnet-password',
        encoding: 'gb18030',
        cols: 120,
        rows: 40,
      });
      expect(connectInput!.loginPrompt).toEqual(/login[: ]*$/i);
      expect(connectInput!.passwordPrompt).toEqual(/password[: ]*$/i);
      expect(JSON.stringify(session)).not.toContain('plain-telnet-password');
      expect(session).toMatchObject({
        kind: 'telnet',
        bookmarkId: tree.bookmarks[0]!.id,
        title: 'Legacy router',
        behavior: { encoding: 'gb18030' },
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
