import { afterEach, describe, expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { etagFor } from './product-repository';
import { SyncProfileRepository } from './sync-profile-repository';

const databases: ProductDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('SyncProfileRepository', () => {
  it('persists bounded provider configuration while public resources omit Vault refs', async () => {
    const database = await ProductDatabase.open();
    databases.push(database);
    const repository = new SyncProfileRepository(database);
    const created = repository.create({
      provider: 'webdav',
      name: 'Team WebDAV',
      endpointUrl: 'https://dav.example.test/sync/',
      remoteId: 'axterm-data.json',
      username: 'operator',
      accessCredentialRef: 'cred_access',
      encryptionCredentialRef: 'cred_encrypt',
      selectedCategories: ['settings', 'bookmarks'],
      autoSyncEnabled: true,
      autoSyncIntervalMinutes: 10,
      autoSyncDirection: 'upload',
    });

    expect(repository.list()).toEqual([
      expect.objectContaining({
        id: created.id,
        provider: 'webdav',
        accessCredentialConfigured: true,
        encryptionConfigured: true,
        selectedCategories: ['settings', 'bookmarks'],
      }),
    ]);
    expect(JSON.stringify(repository.list())).not.toContain('cred_access');
    expect(repository.getRecord(created.id)).toMatchObject({
      accessCredentialRef: 'cred_access',
      encryptionCredentialRef: 'cred_encrypt',
    });

    const updated = repository.update(
      created.id,
      {
        selectedCategories: ['settings'],
        clearEncryptionCredential: true,
        autoSyncDirection: 'download',
      },
      etagFor(created.version),
    );
    expect(updated).toMatchObject({
      selectedCategories: ['settings'],
      encryptionCredentialRef: null,
      encryptionConfigured: false,
      autoSyncDirection: 'download',
      version: 2,
    });
    expect(() =>
      repository.update(created.id, { name: 'stale' }, etagFor(created.version)),
    ).toThrowError(/changed/u);
  });

  it('recovers interrupted runs and enforces one profile per provider', async () => {
    const database = await ProductDatabase.open();
    databases.push(database);
    const repository = new SyncProfileRepository(database);
    const created = repository.create({
      provider: 'github',
      name: 'GitHub',
      endpointUrl: 'https://api.github.com/',
      remoteId: 'gist-id',
      username: null,
      accessCredentialRef: 'cred_access',
      encryptionCredentialRef: null,
      selectedCategories: ['settings'],
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 5,
      autoSyncDirection: 'upload',
    });
    repository.setRunState(created.id, { state: 'uploading' });
    repository.recoverInterrupted();
    expect(repository.get(created.id)).toMatchObject({
      state: 'failed',
      lastErrorCode: 'SYNC_INTERRUPTED',
    });
    expect(() =>
      repository.create({
        provider: 'github',
        name: 'Duplicate',
        endpointUrl: 'https://api.github.com/',
        remoteId: 'other',
        username: null,
        accessCredentialRef: 'cred_other',
        encryptionCredentialRef: null,
        selectedCategories: ['settings'],
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 5,
        autoSyncDirection: 'upload',
      }),
    ).toThrowError(/already exists/u);
  });
});
