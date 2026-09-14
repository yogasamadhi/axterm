import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('Telnet bookmark persistence', () => {
  it('survives migration 19 with prompt settings and only an opaque credential reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-telnet-bookmark-'));
    const path = join(directory, 'product.sqlite');
    try {
      const first = await ProductDatabase.open(path);
      const service = new BookmarkTreeService(new BookmarkRepository(first));
      service.createBookmark(
        {
          protocol: 'telnet',
          hostId: null,
          title: '交换机控制台',
          telnet: {
            hostname: 'switch.example.test',
            port: 2323,
            username: 'operator',
            credentialRef: 'local-telnet-credential-ref',
            loginPrompt: '用户名[:： ]*$',
            passwordPrompt: '密码[:： ]*$',
            encoding: 'gb18030',
            connectionTimeoutMs: 12_000,
          },
        },
        service.snapshot().etag,
      );
      first.close();

      const reopened = await ProductDatabase.open(path);
      const bookmark = new BookmarkRepository(reopened).snapshot().bookmarks[0];
      expect(bookmark).toMatchObject({
        protocol: 'telnet',
        connectionDisplay: 'operator@switch.example.test:2323',
        telnet: {
          credentialRef: 'local-telnet-credential-ref',
          loginPrompt: '用户名[:： ]*$',
          passwordPrompt: '密码[:： ]*$',
          encoding: 'gb18030',
        },
      });
      expect(reopened.get("SELECT value FROM app_meta WHERE key='migration:19'")).toBeDefined();
      const row = reopened.get<{ telnet_payload: string }>(
        'SELECT telnet_payload FROM bookmarks LIMIT 1',
      );
      expect(row).toBeDefined();
      expect(JSON.parse(row!.telnet_payload)).toEqual(bookmark!.telnet);
      expect(row!.telnet_payload).not.toMatch(/"(?:password|secret)"/i);
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
