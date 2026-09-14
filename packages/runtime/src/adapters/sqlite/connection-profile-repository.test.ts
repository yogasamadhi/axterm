import { afterEach, describe, expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { ConnectionProfileRepository } from './connection-profile-repository';
import { ProductRepository } from './product-repository';
import { BookmarkRepository } from './bookmark-repository';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';

const databases: ProductDatabase[] = [];

async function repository() {
  const database = await ProductDatabase.open(':memory:');
  databases.push(database);
  return { database, profiles: new ConnectionProfileRepository(database) };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('ConnectionProfileRepository', () => {
  it('keeps one default Profile and persists reference-only protocol values', async () => {
    const { database, profiles } = await repository();
    const first = profiles.create({ name: 'First' });
    expect(first.isDefault).toBe(true);

    const second = profiles.create({
      name: 'Second',
      isDefault: true,
      ssh: {
        username: 'deploy',
        passwordCredentialRef: 'cred_password',
        privateKeyCredentialRef: null,
        passphraseCredentialRef: null,
        certificateCredentialRef: null,
      },
    });
    expect(second.isDefault).toBe(true);
    expect(profiles.get(first.id)).toMatchObject({ isDefault: false, version: 2 });
    expect(profiles.list().map(({ name }) => name)).toEqual(['Second', 'First']);

    const stored = database.get<{ payload: string }>(
      'SELECT payload FROM connection_profiles WHERE id=?',
      second.id,
    )!.payload;
    expect(stored).toContain('cred_password');
    expect(stored).not.toContain('deploy-secret');
  });

  it('enforces optimistic concurrency and unique names', async () => {
    const { profiles } = await repository();
    const first = profiles.create({ name: 'Personal' });
    profiles.create({ name: 'Production' });
    expect(() => profiles.create({ name: 'production' })).toThrow('already exists');
    expect(() => profiles.update(first.id, { name: 'Changed' }, '"v9"')).toThrow(
      'Connection Profile changed',
    );
    expect(profiles.update(first.id, { name: 'Changed' }, '"v1"')).toMatchObject({
      name: 'Changed',
      version: 2,
    });
  });

  it('promotes a replacement when the default Profile is deleted', async () => {
    const { profiles } = await repository();
    const first = profiles.create({ name: 'First' });
    const second = profiles.create({ name: 'Second' });
    profiles.delete(first.id, '"v1"');
    expect(profiles.get(second.id)).toMatchObject({ isDefault: true, version: 2 });
  });

  it('blocks deletion while a Bookmark still references the Profile', async () => {
    const { database, profiles } = await repository();
    const profile = profiles.create({ name: 'Assigned' });
    const host = new ProductRepository(database).createHost({
      name: 'Profile target',
      hostname: 'profile.example.test',
      username: 'deploy',
      authType: 'agent',
    });
    const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
    bookmarks.createBookmark(
      {
        protocol: 'ssh',
        hostId: host.id,
        title: 'Assigned target',
        connectionProfileId: profile.id,
      },
      bookmarks.snapshot().etag,
    );

    expect(() => profiles.delete(profile.id, '"v1"')).toThrow(
      'still assigned to one or more Bookmarks',
    );
  });
});
