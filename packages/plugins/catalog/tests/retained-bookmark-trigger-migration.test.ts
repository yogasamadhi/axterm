import { DatabaseSync } from 'node:sqlite';
import { Generation2Database } from '../../../../tests/fixtures/migration/generation2-database.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BookmarkTreeService } from '../src/application/bookmark-tree-service.ts';
import { BookmarkRepository } from '../src/adapters/bookmark-repository.ts';
import { catalogStorage } from '../../../../tests/fixtures/level3-catalog-storage.ts';
import { applyHistoricalSql } from '../../../../tests/fixtures/migration/historical-sql.ts';

describe('Bookmark Trigger migration', () => {
  it('defaults existing bookmarks and persists a validated scoped rule across reopen', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'axterm-bookmark-trigger-migration-'));
    const path = resolve(directory, 'axterm.sqlite');
    const input = await Generation2Database.open(path);
    try {
      const now = new Date().toISOString();
      input.run(
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
      input.run("DELETE FROM app_meta WHERE key='migration:28'");
      input.run("DELETE FROM app_meta WHERE key='trigger-list:revision'");
      input.run('DROP TABLE automation_triggers');
      input.run('ALTER TABLE bookmarks DROP COLUMN triggers_payload');
    } finally {
      input.close();
    }

    const historical = new DatabaseSync(path);
    try {
      applyHistoricalSql(historical, 28);
    } finally {
      historical.close();
    }
    let database = await catalogStorage(path);
    try {
      const service = new BookmarkTreeService(new BookmarkRepository(database.sql));
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
      await database.close();
    }

    database = await catalogStorage(path);
    try {
      expect(new BookmarkRepository(database.sql).snapshot().bookmarks[0]?.triggers[0]?.name).toBe(
        'Ready notification',
      );
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
