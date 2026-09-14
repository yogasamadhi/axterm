import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { electermDataImportResultSchema, electermDataPreviewSchema } from '@workspace/contracts';
import { ProductDatabase } from '../adapters/sqlite/database';
import { SyncProfileRepository } from '../adapters/sqlite/sync-profile-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type {
  SyncDataDocument,
  SyncDataSource,
  SyncProvider,
  SyncProviderContext,
  SyncRemoteObject,
} from '../ports/data-sync';
import { ApplicationError } from './errors';
import { DataSyncService } from './data-sync-service';

const databases: ProductDatabase[] = [];
const services: DataSyncService[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

class MemoryProvider implements SyncProvider {
  readonly type = 'custom' as const;
  remote: SyncRemoteObject | null = null;
  hang = false;
  offline = false;

  async load(_context: SyncProviderContext, signal: AbortSignal) {
    if (this.offline) throw new TypeError('connect ECONNREFUSED 127.0.0.1');
    if (this.hang)
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    return this.remote;
  }

  async save(
    _context: SyncProviderContext,
    contents: string,
    expectedRevision: string | null,
    _signal: AbortSignal,
  ) {
    if ((this.remote?.revision ?? null) !== expectedRevision)
      throw new ApplicationError('SYNC_REMOTE_CONFLICT', 'Remote sync object changed', 412);
    const revision = `revision-${Number(this.remote?.revision.split('-')[1] ?? 0) + 1}`;
    this.remote = { contents, revision, updatedAt: new Date().toISOString() };
    return this.remote;
  }
}

function dataSourceFixture() {
  const values: Record<string, unknown> = {
    settings: { appearance: { theme: 'dark' }, marker: 'LOCAL_SETTINGS_MARKER' },
    bookmarks: [{ id: 'bookmark-1' }],
  };
  const previews = new Set<string>();
  const source: SyncDataSource = {
    async snapshot(categories) {
      return {
        formatVersion: 1,
        deviceName: 'test-device',
        appVersion: '0.10.0',
        generatedAt: new Date().toISOString(),
        categories: Object.fromEntries(
          categories.map((category) => {
            const value = structuredClone(values[category] ?? []);
            return [
              category,
              {
                count: Array.isArray(value) ? value.length : 1,
                hash: stableHash(value),
                value,
              },
            ];
          }),
        ),
      } as SyncDataDocument;
    },
    async preview(_document, _categories) {
      const previewId = randomUUID();
      previews.add(previewId);
      return electermDataPreviewSchema.parse({
        previewId,
        sourceName: 'Remote sync data',
        sourceVersion: '1',
        treeEtag: '"bookmark-tree-v1"',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        counts: {
          create: 1,
          unchanged: 0,
          skip: 0,
          groups: 0,
          profiles: 0,
          sshBookmarks: 0,
          quickCommands: 0,
          settings: 1,
          credentialMetadata: 0,
        },
        entries: [
          {
            key: 'dataset:settings',
            kind: 'settings',
            sourceId: 'settings',
            name: 'Application settings',
            action: 'create',
            reasons: [],
            mappedFields: ['appearance.theme'],
            omittedFields: [],
          },
        ],
      });
    },
    getPreview(previewId) {
      if (!previews.has(previewId)) return null;
      return electermDataPreviewSchema.parse({
        previewId,
        sourceName: 'Remote sync data',
        sourceVersion: '1',
        treeEtag: '"bookmark-tree-v1"',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        counts: {
          create: 1,
          unchanged: 0,
          skip: 0,
          groups: 0,
          profiles: 0,
          sshBookmarks: 0,
          quickCommands: 0,
          settings: 1,
          credentialMetadata: 0,
        },
        entries: [],
      });
    },
    async commit(previewId) {
      if (!previews.delete(previewId)) throw new Error('preview missing');
      return electermDataImportResultSchema.parse({
        previewId,
        counts: {
          create: 1,
          unchanged: 0,
          skip: 0,
          groups: 0,
          profiles: 0,
          sshBookmarks: 0,
          quickCommands: 0,
          settings: 1,
          credentialMetadata: 0,
        },
        createdCredentialCount: 0,
        settingsApplied: true,
        credentialMetadataReported: 0,
        tree: { revision: 1, etag: '"bookmark-tree-v1"', groups: [], bookmarks: [] },
      });
    },
    cancel(previewId) {
      previews.delete(previewId);
    },
  };
  return { source, values, previews };
}

async function fixture(encrypted = false) {
  const database = await ProductDatabase.open();
  databases.push(database);
  const repository = new SyncProfileRepository(database);
  const provider = new MemoryProvider();
  const data = dataSourceFixture();
  const secrets = new Map([
    ['cred_access', 'ACCESS_TOKEN_SECRET'],
    ['cred_encrypt', 'SYNC_ENCRYPTION_PASSWORD'],
  ]);
  const service = new DataSyncService(repository, [provider], data.source, {
    resolve: async (ref) => {
      const secret = secrets.get(ref);
      if (!secret) throw new Error('credential missing');
      return secret;
    },
    delete: async (ref) => {
      secrets.delete(ref);
    },
  });
  services.push(service);
  const profile = await service.create({
    provider: 'custom',
    name: 'Test provider',
    endpointUrl: 'https://sync.example.test/api/',
    remoteId: 'user-1',
    username: null,
    accessCredentialRef: 'cred_access',
    encryptionCredentialRef: encrypted ? 'cred_encrypt' : null,
    selectedCategories: ['settings', 'bookmarks'],
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 5,
    autoSyncDirection: 'upload',
  });
  return { database, repository, provider, data, secrets, service, profile };
}

describe('DataSyncService', () => {
  it('uploads, compares hashes, downloads a reviewable preview and commits explicitly', async () => {
    const context = await fixture();
    const missing = await context.service.compare(context.profile.id);
    expect(missing).toMatchObject({
      remoteExists: false,
      categories: [
        expect.objectContaining({ category: 'settings', state: 'local-only' }),
        expect.objectContaining({ category: 'bookmarks', state: 'local-only' }),
      ],
    });

    const uploaded = await context.service.run(context.profile.id, 'upload');
    expect(uploaded).toMatchObject({ direction: 'upload', uploaded: true, preview: null });
    expect(JSON.stringify(uploaded)).not.toContain('cred_access');
    expect(await context.service.compare(context.profile.id)).toMatchObject({
      categories: [
        expect.objectContaining({ category: 'settings', state: 'equal' }),
        expect.objectContaining({ category: 'bookmarks', state: 'equal' }),
      ],
    });

    context.data.values.settings = { appearance: { theme: 'light' } };
    expect(await context.service.compare(context.profile.id)).toMatchObject({
      categories: expect.arrayContaining([
        expect.objectContaining({ category: 'settings', state: 'different' }),
      ]),
    });
    const downloaded = await context.service.run(context.profile.id, 'download');
    expect(downloaded.profile.state).toBe('download-preview');
    expect(downloaded.preview?.counts.settings).toBe(1);
    expect(context.service.pendingDownload(context.profile.id)).toMatchObject({
      previewId: downloaded.preview?.previewId,
      counts: { settings: 1 },
    });
    const committed = await context.service.commitDownload(
      context.profile.id,
      downloaded.preview!.previewId,
      downloaded.preview!.treeEtag,
    );
    expect(committed).toMatchObject({
      profile: { state: 'idle', pendingPreviewId: null },
      result: { settingsApplied: true },
    });
  });

  it('encrypts the remote envelope and rejects a missing decryption credential', async () => {
    const context = await fixture(true);
    await context.service.run(context.profile.id, 'upload');
    expect(context.provider.remote?.contents).not.toContain('LOCAL_SETTINGS_MARKER');
    expect(context.provider.remote?.contents).not.toContain('SYNC_ENCRYPTION_PASSWORD');
    const updated = context.repository.update(
      context.profile.id,
      { clearEncryptionCredential: true },
      `"v${context.repository.get(context.profile.id).version}"`,
    );
    await expect(context.service.compare(updated.id)).rejects.toMatchObject({
      code: 'SYNC_NOT_CONFIGURED',
    });
  });

  it('cancels an in-flight provider request and persists only a redacted error code', async () => {
    const context = await fixture();
    context.provider.hang = true;
    const comparison = context.service.compare(context.profile.id);
    await vi.waitFor(() => expect(context.service.resourceCount()).toBe(1));
    context.service.cancel(context.profile.id);
    await expect(comparison).rejects.toMatchObject({ code: 'SYNC_ABORTED' });
    expect(context.repository.get(context.profile.id)).toMatchObject({
      state: 'failed',
      lastErrorCode: 'SYNC_ABORTED',
    });
    expect(JSON.stringify(context.repository.get(context.profile.id))).not.toContain(
      'ACCESS_TOKEN_SECRET',
    );
  });

  it('maps an offline provider failure to a stable redacted error', async () => {
    const context = await fixture();
    context.provider.offline = true;
    await expect(context.service.test(context.profile.id)).rejects.toMatchObject({
      code: 'SYNC_PROVIDER_FAILED',
      message: 'Sync provider request failed',
    });
    expect(context.repository.get(context.profile.id)).toMatchObject({
      state: 'failed',
      lastErrorCode: 'SYNC_PROVIDER_FAILED',
    });
    expect(JSON.stringify(context.repository.get(context.profile.id))).not.toContain(
      'ECONNREFUSED',
    );
  });

  it('runs due automatic uploads with a two-profile scheduler bound', async () => {
    const context = await fixture();
    const current = context.repository.get(context.profile.id);
    context.repository.update(
      current.id,
      { autoSyncEnabled: true, autoSyncIntervalMinutes: 1 },
      `"v${current.version}"`,
    );
    await context.service.tick(Date.now() + 61_000);
    expect(context.provider.remote).not.toBeNull();
    expect(context.repository.get(context.profile.id)).toMatchObject({
      state: 'idle',
      lastErrorCode: null,
      lastSyncAt: expect.any(String),
    });
  });

  it('keeps automatic downloads in a recoverable explicit-confirmation preview', async () => {
    const context = await fixture();
    await context.service.run(context.profile.id, 'upload');
    context.data.values.settings = { appearance: { theme: 'light' } };
    const current = context.repository.get(context.profile.id);
    context.repository.update(
      current.id,
      {
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 1,
        autoSyncDirection: 'download',
      },
      `"v${current.version}"`,
    );

    await context.service.tick(Date.now() + 61_000);

    const pending = context.repository.get(context.profile.id);
    expect(pending).toMatchObject({
      state: 'download-preview',
      pendingPreviewId: expect.any(String),
    });
    expect(context.service.pendingDownload(context.profile.id).previewId).toBe(
      pending.pendingPreviewId,
    );
  });
});
