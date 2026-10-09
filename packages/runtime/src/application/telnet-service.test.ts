import { describe, expect, it, vi } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import type { TerminalChannel } from '../ports/terminal-channel';
import type { TelnetConnectInput, TelnetTransport } from '../ports/telnet-transport';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { TelnetService } from './telnet-service';
import { TerminalService } from './terminal-service';

describe('TelnetService', () => {
  it('resolves the local credential, omits it from metadata and owns channel cleanup', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
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
      const terminals = new TerminalService({
        open: () => {
          throw new Error('PTY must not be used for Telnet');
        },
      });
      const service = new TelnetService(
        bookmarks,
        profiles,
        { resolveCredential } as never,
        transport,
        terminals,
      );

      const session = await service.open({
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
      database.close();
    }
  });
});
