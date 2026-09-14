import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';

describe('Bookmark Trigger migration', () => {
  it('defaults existing bookmarks and persists a validated scoped rule across reopen', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'axterm-bookmark-trigger-migration-'));
    const path = resolve(directory, 'axterm.sqlite');
    let database = await ProductDatabase.open(path);
    try {
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO bookmarks(
          id, group_id, protocol, host_id, title, color, description, position,
          profile_id, connection_profile_id, quick_commands_payload, triggers_payload,
          ftp_payload, telnet_payload, serial_payload, rdp_payload, vnc_payload, spice_payload,
          web_payload, created_at, updated_at, version
        ) VALUES (?, NULL, 'local', NULL, ?, NULL, '', 0, NULL, NULL, '[]', '[]', 'null',
          'null', 'null', 'null', 'null', 'null', 'null', ?, ?, 1)`,
        '00000000-0000-4000-8000-000000000028',
        'Legacy local shell',
        now,
        now,
      );
      database.run("DELETE FROM app_meta WHERE key='migration:28'");
      database.run("DELETE FROM app_meta WHERE key='trigger-list:revision'");
      database.run('DROP TABLE automation_triggers');
      database.run('ALTER TABLE bookmarks DROP COLUMN triggers_payload');
    } finally {
      database.close();
    }

    database = await ProductDatabase.open(path);
    try {
      const service = new BookmarkTreeService(new BookmarkRepository(database));
      let tree = service.snapshot();
      expect(tree.bookmarks[0]?.triggers).toEqual([]);
      tree = service.updateBookmark(
        tree.bookmarks[0]!.id,
        {
          triggers: [
            {
              id: crypto.randomUUID(),
              name: 'Ready notification',
              enabled: true,
              match: { type: 'regex', value: 'ready$', caseSensitive: false },
              action: { type: 'notify', value: '' },
              sendEnter: false,
              mode: 'once',
              cooldownMs: 0,
            },
          ],
        },
        tree.etag,
      );
      expect(tree.bookmarks[0]?.triggers[0]).toMatchObject({
        name: 'Ready notification',
        mode: 'once',
      });
    } finally {
      database.close();
    }

    database = await ProductDatabase.open(path);
    try {
      expect(new BookmarkRepository(database).snapshot().bookmarks[0]?.triggers[0]?.name).toBe(
        'Ready notification',
      );
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
