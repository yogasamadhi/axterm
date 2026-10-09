import { describe, expect, it, vi } from 'vitest';
import type { HostWebViewState } from '@workspace/contracts/desktop';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { BookmarkTreeService } from './bookmark-tree-service';
import { WebSessionService } from './web-session-service';

describe('WebSessionService', () => {
  it('owns the native view lifecycle and never exposes transient authentication secrets', async () => {
    const database = await ProductDatabase.open();
    try {
      const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
      const tree = bookmarks.createBookmark(
        {
          protocol: 'web',
          hostId: null,
          title: 'Web fixture',
          connectionProfileId: null,
          web: {
            url: 'https://web.example.test/app',
            userAgent: 'Axterm-Test/1',
            hideAddressBar: false,
          },
        },
        bookmarks.snapshot().etag,
      );
      let state: HostWebViewState = {
        id: '00000000-0000-4000-8000-000000000000',
        state: 'loading',
        url: 'https://web.example.test/app',
        title: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
        visible: false,
      };
      const host = {
        createWebView: vi.fn(async (input: { id: string }) => {
          state = { ...state, id: input.id };
          return state;
        }),
        webView: vi.fn(async () => state),
        presentWebView: vi.fn(async (_id: string, input: { visible?: boolean }) => {
          state = { ...state, visible: input.visible ?? state.visible };
          return state;
        }),
        performWebViewAction: vi.fn(async (_id: string, input: { action: string }) => {
          state = { ...state, loading: input.action === 'reload' };
          return state;
        }),
        authenticateWebView: vi.fn(async () => {
          state = { ...state, state: 'loading' as const, loading: true };
          return state;
        }),
        closeWebView: vi.fn(async () => undefined),
      };
      const service = new WebSessionService(bookmarks, host as never);

      const created = await service.create({ bookmarkId: tree.bookmarks[0]!.id });
      expect(created).toMatchObject({
        title: 'Web fixture',
        url: 'https://web.example.test/app',
        userAgent: 'Axterm-Test/1',
        hideAddressBar: false,
      });
      expect(host.createWebView).toHaveBeenCalledWith({
        id: created.id,
        url: 'https://web.example.test/app',
        userAgent: 'Axterm-Test/1',
      });

      await service.present(created.id, {
        bounds: { x: 20, y: 90, width: 800, height: 600 },
        visible: true,
      });
      await service.perform(created.id, { action: 'reload' });
      await service.authenticate(created.id, {
        challengeId: '11111111-1111-4111-8111-111111111111',
        username: 'operator',
        password: 'transient-password',
      });
      expect(host.presentWebView).toHaveBeenCalledOnce();
      expect(host.performWebViewAction).toHaveBeenCalledWith(created.id, { action: 'reload' });
      expect(JSON.stringify(await service.get(created.id))).not.toContain('transient-password');

      await service.close(created.id);
      expect(host.closeWebView).toHaveBeenCalledWith(created.id);
      expect(service.resourceCount()).toBe(0);
    } finally {
      database.close();
    }
  });
});
