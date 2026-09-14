import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import type { RdpRelay, RdpRelaySocket } from '../ports/rdp-relay';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { RdpSessionService } from './rdp-session-service';

class TestSocket extends EventEmitter implements RdpRelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
}

describe('RdpSessionService', () => {
  it('resolves a local password once, keeps metadata secret-free and owns relay cleanup', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
      const tree = bookmarks.createBookmark(
        {
          protocol: 'rdp',
          hostId: null,
          title: 'Desktop fixture',
          rdp: {
            hostname: 'desktop.example.test',
            port: 3_389,
            username: 'operator',
            credentialRef: 'local-rdp-ref',
            domain: 'LAB',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 5_000,
            desktopWidth: 1_280,
            desktopHeight: 720,
            scaleViewport: false,
            clipboard: true,
          },
        },
        bookmarks.snapshot().etag,
      );
      const close = vi.fn();
      let attached: Parameters<RdpRelay['attach']>[0] | undefined;
      const relay: RdpRelay = {
        attach: vi.fn(async (input) => {
          attached = input;
          input.onReady();
          return { close };
        }),
      };
      const resolveCredential = vi.fn(async () => 'rdp-secret');
      const service = new RdpSessionService(
        bookmarks,
        profiles,
        { resolveCredential } as never,
        relay,
      );

      const session = await service.create({ bookmarkId: tree.bookmarks[0]!.id });
      expect(JSON.stringify(session)).not.toContain('rdp-secret');
      expect(resolveCredential).toHaveBeenCalledWith('local-rdp-ref');
      expect(service.claimCredentials(session.id)).toEqual({
        username: 'operator',
        password: 'rdp-secret',
        domain: 'LAB',
        destination: 'desktop.example.test:3389',
      });
      expect(() => service.claimCredentials(session.id)).toThrow(/already claimed/i);
      await service.attach(session.id, new TestSocket());
      expect(attached?.target).toEqual({ host: 'desktop.example.test', port: 3_389 });
      expect(service.get(session.id).state).toBe('ready');
      await service.close(session.id);
      expect(close).toHaveBeenCalledOnce();
      expect(service.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});
