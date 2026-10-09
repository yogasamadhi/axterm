import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { syncProfileInputSchema } from '@workspace/contracts';
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
        format: 'axterm-sync-v1',
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

  it('recovers interrupted runs and enforces one profile per provider and format', async () => {
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

  it('marks existing sync-profile rows as Axterm-owned during migration 36', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'axterm-sync-profile-format-migration-'));
    const path = resolve(directory, 'axterm.sqlite');
    let database = await ProductDatabase.open(path);
    const repository = new SyncProfileRepository(database);
    const created = repository.create({
      provider: 'custom',
      name: 'Existing custom sync',
      endpointUrl: 'https://sync.example.test/',
      remoteId: 'existing',
      username: null,
      accessCredentialRef: 'cred_access',
      encryptionCredentialRef: null,
      selectedCategories: ['settings'],
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 5,
      autoSyncDirection: 'upload',
    });
    database.close();

    try {
      const legacy = new DatabaseSync(path);
      legacy.prepare("DELETE FROM app_meta WHERE key='migration:37'").run();
      legacy.exec('DROP INDEX sync_profiles_provider_format_unique;');
      legacy.prepare("DELETE FROM app_meta WHERE key='migration:36'").run();
      legacy.exec('ALTER TABLE sync_profiles DROP COLUMN format;');
      legacy.close();

      database = await ProductDatabase.open(path);
      expect(
        database.get<{ format: string }>('SELECT format FROM sync_profiles WHERE id=?', created.id),
      ).toEqual({
        format: 'axterm-sync-v1',
      });
      expect(database.get("SELECT value FROM app_meta WHERE key='migration:36'")).toBeDefined();
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not permit clients to mislabel a legacy source as Axterm sync', () => {
    expect(
      syncProfileInputSchema.safeParse({
        provider: 'webdav',
        format: 'axterm-sync-v1',
        name: 'Do not accept this yet',
        endpointUrl: 'https://dav.example.test/sync/',
        remoteId: 'axterm-data.json',
        username: null,
        accessCredentialRef: 'cred_access',
        encryptionCredentialRef: null,
        selectedCategories: ['settings'],
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 5,
        autoSyncDirection: 'upload',
      }).success,
    ).toBe(false);
  });
});
