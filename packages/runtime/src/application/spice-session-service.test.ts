import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import type { SpiceRelay, SpiceRelaySocket } from '../ports/spice-relay';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { SpiceSessionService } from './spice-session-service';

class TestSocket extends EventEmitter implements SpiceRelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
}

describe('SpiceSessionService', () => {
  it('resolves a local ticket once, exposes no secret metadata and owns every channel', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
      const profile = await profiles.create({
        name: 'SPICE identity',
        spice: { passwordCredentialRef: 'profile-spice-ref' },
      });
      const tree = bookmarks.createBookmark(
        {
          protocol: 'spice',
          hostId: null,
          title: 'SPICE fixture',
          connectionProfileId: profile.id,
          spice: {
            hostname: 'desktop.example.test',
            port: 5_901,
            credentialRef: 'bookmark-spice-ref',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 5_000,
            viewOnly: true,
            scaleViewport: false,
          },
        },
        bookmarks.snapshot().etag,
      );
      const closes = [vi.fn(), vi.fn()];
      let channel = 0;
      const relay: SpiceRelay = {
        attach: vi.fn(async (input) => {
          input.onReady();
          return { close: closes[channel++]! };
        }),
      };
      const resolveCredential = vi.fn(async () => 'spice-secret');
      const service = new SpiceSessionService(
        bookmarks,
        profiles,
        { resolveCredential } as never,
        relay,
      );

      const session = await service.create({ bookmarkId: tree.bookmarks[0]!.id });
      expect(session).toMatchObject({ viewOnly: true, scaleViewport: false, activeChannels: 0 });
      expect(JSON.stringify(session)).not.toContain('spice-secret');
      expect(resolveCredential).toHaveBeenCalledWith('profile-spice-ref');
      expect(service.claimCredentials(session.id)).toEqual({ password: 'spice-secret' });
      expect(() => service.claimCredentials(session.id)).toThrow(/already claimed/i);

      await service.attach(session.id, new TestSocket());
      await service.attach(session.id, new TestSocket());
      expect(relay.attach).toHaveBeenCalledTimes(2);
      expect(service.get(session.id)).toMatchObject({ state: 'ready', activeChannels: 2 });

      await service.close(session.id);
      expect(closes[0]).toHaveBeenCalledOnce();
      expect(closes[1]).toHaveBeenCalledOnce();
      expect(service.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});
