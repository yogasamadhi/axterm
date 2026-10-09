import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BookmarkRepository } from './bookmark-repository';
import { ProductDatabase } from './database';
import { ProductRepository } from './product-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Bookmark database migration', () => {
  it('creates one SSH bookmark per legacy Host without copying connection or credential facts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-bookmark-migration-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');

    let database = await ProductDatabase.open(path);
    const products = new ProductRepository(database);
    const production = products.createHostGroup({ name: 'Production', sortOrder: 2 });
    const staging = products.createHostGroup({ name: 'Staging', sortOrder: 2 });
    const favorite = products.createHost({
      groupId: production.id,
      name: 'favorite-host',
      hostname: 'favorite.internal.example',
      port: 2201,
      username: 'favorite-user',
      authType: 'privateKey',
      credentialRef: 'cred_private_key_marker',
      passphraseCredentialRef: 'cred_passphrase_marker',
      jumpHostId: null,
      favorite: true,
    });
    const ordinary = products.createHost({
      groupId: production.id,
      name: 'ordinary-host',
      hostname: 'ordinary.internal.example',
      port: 2202,
      username: 'ordinary-user',
      authType: 'password',
      credentialRef: 'cred_password_marker',
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    const ungrouped = products.createHost({
      groupId: null,
      name: 'ungrouped-host',
      hostname: 'ungrouped.internal.example',
      port: 22,
      username: 'ungrouped-user',
      authType: 'agent',
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    });
    database.close();

    // Recreate the exact pre-ADR-005 state while retaining the already verified
    // checksums for migrations 1 and 2, then let ProductDatabase apply migration 3.
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA foreign_keys=ON; DROP TABLE bookmarks; DROP TABLE bookmark_groups;');
    legacy
      .prepare("DELETE FROM app_meta WHERE key IN ('migration:3', 'bookmark-tree:revision')")
      .run();
    legacy.close();

    database = await ProductDatabase.open(path);
    try {
      const snapshot = new BookmarkRepository(database).snapshot();
      expect(snapshot.revision).toBe(1);
      expect(snapshot.groups).toEqual([
        expect.objectContaining({
          id: production.id,
          parentId: null,
          name: production.name,
          position: 0,
        }),
        expect.objectContaining({
          id: staging.id,
          parentId: null,
          name: staging.name,
          position: 1,
        }),
      ]);
      expect(snapshot.bookmarks).toEqual([
        expect.objectContaining({
          id: ungrouped.id,
          groupId: null,
          protocol: 'ssh',
          hostId: ungrouped.id,
          title: ungrouped.name,
          position: 2,
        }),
        expect.objectContaining({
          id: favorite.id,
          groupId: production.id,
          protocol: 'ssh',
          hostId: favorite.id,
          title: favorite.name,
          position: 0,
        }),
        expect.objectContaining({
          id: ordinary.id,
          groupId: production.id,
          protocol: 'ssh',
          hostId: ordinary.id,
          title: ordinary.name,
          position: 1,
        }),
      ]);
      const nodesByParent = new Map<string, number[]>();
      for (const group of snapshot.groups) {
        const key = group.parentId ?? 'root';
        nodesByParent.set(key, [...(nodesByParent.get(key) ?? []), group.position]);
      }
      for (const bookmark of snapshot.bookmarks) {
        const key = bookmark.groupId ?? 'root';
        nodesByParent.set(key, [...(nodesByParent.get(key) ?? []), bookmark.position]);
      }
      for (const positions of nodesByParent.values())
        expect(positions.sort((left, right) => left - right)).toEqual(
          Array.from({ length: positions.length }, (_, index) => index),
        );
      const bookmarkColumns = database
        .all<{ name: string }>('PRAGMA table_info(bookmarks)')
        .map((column) => column.name);
      expect(bookmarkColumns).not.toEqual(
        expect.arrayContaining([
          'hostname',
          'port',
          'username',
          'auth_type',
          'credential_ref',
          'passphrase_credential_ref',
          'password',
          'private_key',
        ]),
      );
      expect(JSON.stringify(snapshot)).not.toContain('cred_private_key_marker');
      expect(snapshot.bookmarks.find((item) => item.id === favorite.id)?.connectionDisplay).toBe(
        'favorite-user@favorite.internal.example:2201',
      );
    } finally {
      database.close();
    }
  });
});
