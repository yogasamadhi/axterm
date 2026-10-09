import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import type { VncRelay, VncRelaySocket } from '../ports/vnc-relay';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { VncSessionService } from './vnc-session-service';

class TestSocket extends EventEmitter implements VncRelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
}

describe('VncSessionService', () => {
  it('resolves a local password once, exposes no secret metadata and owns relay cleanup', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
      const tree = bookmarks.createBookmark(
        {
          protocol: 'vnc',
          hostId: null,
          title: 'VNC fixture',
          vnc: {
            hostname: 'desktop.example.test',
            port: 5_901,
            username: 'operator',
            credentialRef: 'local-vnc-ref',
            proxy: { mode: 'direct' },
            jumpHostId: null,
            connectionTimeoutMs: 5_000,
            viewOnly: true,
            clipViewport: true,
            scaleViewport: false,
            qualityLevel: 7,
            compressionLevel: 4,
            shared: false,
            showDotCursor: true,
            clipboard: false,
          },
        },
        bookmarks.snapshot().etag,
      );
      const close = vi.fn();
      let attached: Parameters<VncRelay['attach']>[0] | undefined;
      const relay: VncRelay = {
        attach: vi.fn(async (input) => {
          attached = input;
          input.onReady();
          return { close };
        }),
      };
      const resolveCredential = vi.fn(async () => 'vnc-secret');
      const service = new VncSessionService(
        bookmarks,
        profiles,
        { resolveCredential } as never,
        relay,
      );

      const session = await service.create({ bookmarkId: tree.bookmarks[0]!.id });
      expect(session).toMatchObject({
        viewOnly: true,
        clipViewport: true,
        qualityLevel: 7,
        compressionLevel: 4,
        shared: false,
      });
      expect(JSON.stringify(session)).not.toContain('vnc-secret');
      expect(resolveCredential).toHaveBeenCalledWith('local-vnc-ref');
      expect(service.claimCredentials(session.id)).toEqual({
        username: 'operator',
        password: 'vnc-secret',
      });
      expect(() => service.claimCredentials(session.id)).toThrow(/already claimed/i);
      await service.attach(session.id, new TestSocket());
      expect(attached).toBeDefined();
      expect(service.get(session.id).state).toBe('ready');
      await service.close(session.id);
      expect(close).toHaveBeenCalledOnce();
      expect(service.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});
