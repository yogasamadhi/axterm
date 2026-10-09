import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  axtermConfigurationImportResultSchema,
  axtermConfigurationPreviewSchema,
  axtermSyncDocumentSchema,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import {
  CustomSyncProvider,
  GistSyncProvider,
  WebDavSyncProvider,
} from '../adapters/data-sync/http-sync-providers';
import { ProductDatabase } from '../adapters/sqlite/database';
import { SyncProfileRepository } from '../adapters/sqlite/sync-profile-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type {
  AxtermSyncDataSource,
  SyncProvider,
  SyncProviderContext,
  SyncRemoteObject,
} from '../ports/data-sync';
import { ApplicationError } from './errors';
import { DataSyncService } from './data-sync-service';

const databases: ProductDatabase[] = [];
const services: DataSyncService[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

class MemoryProvider implements SyncProvider {
  readonly type = 'custom' as const;
  remote: SyncRemoteObject | null = null;
  backupBytes: Uint8Array | null = null;
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

  async readBackup(context: SyncProviderContext, signal: AbortSignal) {
    const remote = await this.load(context, signal);
    return remote ? (this.backupBytes ?? Buffer.from(remote.contents, 'utf8')) : null;
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

function axtermDataSourceFixture(): AxtermSyncDataSource {
  const previews = new Map<string, ReturnType<typeof axtermConfigurationPreviewSchema.parse>>();
  return {
    snapshot(categories) {
      return axtermSyncDocumentSchema.parse({
        format: 'axterm-sync',
        formatVersion: 1,
        deviceName: 'axterm-sync-test-device',
        appVersion: '0.10.0',
        generatedAt: new Date().toISOString(),
        categories: Object.fromEntries(
          categories.map((category) => {
            const value =
              category === 'settings'
                ? { settings: { appearance: { theme: 'axterm-dark' } } }
                : category === 'bookmarks'
                  ? { hostGroups: [], hosts: [], bookmarkGroups: [], bookmarks: [] }
                  : [];
            return [
              category,
              {
                count: category === 'settings' ? 1 : 0,
                hash: stableHash(value),
                value,
              },
            ];
          }),
        ),
        omissions: { fields: [], excludedCollections: ['vault-secret-values'] },
      });
    },
    preview(document, categories) {
      const preview = axtermConfigurationPreviewSchema.parse({
        previewId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        appVersion: document.appVersion,
        exportedAt: document.generatedAt,
        bytes: Buffer.byteLength(JSON.stringify(document)),
        sha256: stableHash(document),
        entityCount: 0,
        counts: { create: 0, unchanged: 0, conflict: 0, skipped: 0 },
        settings: categories.includes('settings') ? 'will-apply' : 'preserved',
        canCommit: true,
        issues: [],
        issueCount: 0,
        issuesTruncated: false,
      });
      previews.set(preview.previewId, preview);
      return preview;
    },
    getPreview(previewId) {
      return previews.get(previewId) ?? null;
    },
    commit(previewId) {
      const preview = previews.get(previewId);
      if (!preview) throw new ApplicationError('NOT_FOUND', 'preview missing', 404);
      previews.delete(previewId);
      return axtermConfigurationImportResultSchema.parse({
        previewId,
        entityCount: preview.entityCount,
        counts: preview.counts,
        settings: preview.settings === 'will-apply' ? 'applied' : 'preserved',
      });
    },
    cancel(previewId) {
      previews.delete(previewId);
    },
  };
}

async function fixture(
  encrypted = false,
  backupPath?: string,
  axtermDataSource?: AxtermSyncDataSource,
) {
  const database = await ProductDatabase.open();
  databases.push(database);
  const repository = new SyncProfileRepository(database);
  const provider = new MemoryProvider();
  const secrets = new Map([
    ['cred_access', 'ACCESS_TOKEN_SECRET'],
    ['cred_encrypt', 'SYNC_ENCRYPTION_PASSWORD'],
  ]);
  const service = new DataSyncService(
    repository,
    [provider],
    {
      resolve: async (ref) => {
        const secret = secrets.get(ref);
        if (!secret) throw new Error('credential missing');
        return secret;
      },
      delete: async (ref) => {
        secrets.delete(ref);
      },
    },
    backupPath
      ? ({
          async resolveGrant(grantId: string) {
            return {
              grantId,
              kind: grantId === 'save-grant' ? ('save-target' as const) : ('file' as const),
              name: 'remote-backup.json',
              permissions: grantId === 'save-grant' ? (['write'] as const) : (['read'] as const),
              createdAt: new Date().toISOString(),
              path: backupPath,
            };
          },
        } satisfies Pick<HostCapabilityClient, 'resolveGrant'>)
      : undefined,
    axtermDataSource ?? axtermDataSourceFixture(),
  );
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
  return { database, repository, provider, secrets, service, profile };
}

describe('DataSyncService', () => {
  it('backs up an encrypted remote object unchanged without mutating the remote or pending preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-backup-'));
    directories.push(directory);
    const path = join(directory, 'remote-backup.json');
    const context = await fixture(true, path);
    await context.service.run(context.profile.id, 'upload');
    const original = context.provider.remote!.contents;
    const preview = await context.service.previewAxtermDownload(context.profile.id);
    const before = context.repository.get(context.profile.id);
    const result = await context.service.backupRemote(context.profile.id, 'save-grant');

    expect(await readFile(path, 'utf8')).toBe(original);
    expect(result).toEqual({
      bytes: Buffer.byteLength(original),
      sha256: createHash('sha256').update(original).digest('hex'),
    });
    expect(context.provider.remote!.contents).toBe(original);
    expect(context.repository.get(context.profile.id)).toEqual(before);
    expect(context.service.pendingAxtermDownload(context.profile.id).previewId).toBe(
      preview.preview.previewId,
    );
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(['remote-backup.json']);
  });

  it('saves byte-stream provider backups without decoding or rewriting remote bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-backup-bytes-'));
    directories.push(directory);
    const path = join(directory, 'remote-backup.bin');
    const context = await fixture(false, path);
    context.provider.remote = {
      contents: 'not-used-for-backup',
      revision: 'opaque-revision',
      updatedAt: new Date().toISOString(),
    };
    const original = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a]);
    context.provider.backupBytes = original;

    const result = await context.service.backupRemote(context.profile.id, 'save-grant');

    expect(await readFile(path)).toEqual(original);
    expect(result).toEqual({
      bytes: original.byteLength,
      sha256: createHash('sha256').update(original).digest('hex'),
    });
    expect(context.provider.remote?.contents).toBe('not-used-for-backup');
    expect(await readdir(directory)).toEqual(['remote-backup.bin']);
  });

  it('backs up each built-in provider payload through the same save-grant boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-provider-backup-'));
    directories.push(directory);
    const remotePayload = '{"formatVersion":1,"encrypted":true,"ciphertext":"PROVIDER_BACKUP"}\n';
    const cases = [
      {
        type: 'github' as const,
        endpointUrl: 'https://api.github.com/gists',
        remoteId: 'github-backup',
        provider: (fetcher: typeof fetch) => new GistSyncProvider('github', fetcher),
        response: () =>
          new Response(
            JSON.stringify({
              files: {
                'axterm-sync-v1.json': {
                  content: 'partial',
                  size: Buffer.byteLength(remotePayload),
                  truncated: true,
                  raw_url:
                    'https://gist.githubusercontent.com/alice/github-backup/raw/0123456789abcdef0123/axterm-sync-v1.json',
                },
              },
            }),
            { headers: { ETag: '"github-backup"' } },
          ),
        rawResponse: () => new Response(Buffer.from(remotePayload, 'utf8')),
        authorization: (secret: string) => `Bearer ${secret}`,
      },
      {
        type: 'gitee' as const,
        endpointUrl: 'https://gitee.com/api/v5/gists',
        remoteId: 'gitee-backup',
        provider: (fetcher: typeof fetch) => new GistSyncProvider('gitee', fetcher),
        response: () =>
          new Response(
            JSON.stringify({ files: { 'axterm-sync-v1.json': { content: remotePayload } } }),
            { headers: { ETag: '"gitee-backup"' } },
          ),
        authorization: (secret: string) => `token ${secret}`,
      },
      {
        type: 'webdav' as const,
        endpointUrl: 'https://dav.example.test/storage/',
        remoteId: 'webdav-backup.json',
        provider: (fetcher: typeof fetch) => new WebDavSyncProvider(fetcher),
        response: () => new Response(remotePayload, { headers: { ETag: '"webdav-backup"' } }),
        authorization: (secret: string) => `Basic ${Buffer.from(`:${secret}`).toString('base64')}`,
      },
      {
        type: 'custom' as const,
        endpointUrl: 'https://sync.example.test/api',
        remoteId: 'custom-backup',
        provider: (fetcher: typeof fetch) => new CustomSyncProvider(fetcher),
        response: () =>
          new Response(
            JSON.stringify({ files: { 'axterm-sync-v1.json': { content: remotePayload } } }),
          ),
        authorization: (_secret: string) => 'custom-jwt',
      },
    ];

    for (const entry of cases) {
      const secret = `${entry.type}-backup-secret`;
      const path = join(directory, `${entry.type}-backup.json`);
      const requests: Array<{ url: RequestInfo | URL; init: RequestInit | undefined }> = [];
      const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url, init });
        return requests.length === 1
          ? entry.response()
          : (entry.rawResponse?.() ?? entry.response());
      });
      const database = await ProductDatabase.open();
      databases.push(database);
      const repository = new SyncProfileRepository(database);
      const service = new DataSyncService(
        repository,
        [entry.provider(fetcher as typeof fetch)],
        { resolve: async (reference) => (reference === 'credential' ? secret : '') },
        {
          async resolveGrant(grantId: string) {
            return {
              grantId,
              kind: 'save-target' as const,
              name: `${entry.type}-backup.json`,
              permissions: ['write'] as const,
              createdAt: new Date().toISOString(),
              path,
            };
          },
        },
        axtermDataSourceFixture(),
      );
      services.push(service);
      const profile = await service.create({
        provider: entry.type,
        name: `${entry.type} backup`,
        endpointUrl: entry.endpointUrl,
        remoteId: entry.remoteId,
        username: null,
        accessCredentialRef: 'credential',
        encryptionCredentialRef: null,
        selectedCategories: ['settings'],
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 5,
        autoSyncDirection: 'upload',
      });

      const result = await service.backupRemote(profile.id, 'save-grant');

      expect(await readFile(path)).toEqual(Buffer.from(remotePayload, 'utf8'));
      expect(result).toEqual({
        bytes: Buffer.byteLength(remotePayload),
        sha256: createHash('sha256').update(remotePayload).digest('hex'),
      });
      expect(repository.get(profile.id).state).toBe('idle');
      expect(fetcher).toHaveBeenCalledTimes(entry.rawResponse ? 2 : 1);
      const request = requests[0];
      if (!request) throw new Error('Sync provider did not issue a request');
      expect(request.init?.method).toBe('GET');
      expect(String(request.url)).not.toContain(secret);
      const authorization = new Headers(request.init?.headers).get('Authorization') ?? '';
      if (entry.type === 'custom') expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
      else expect(authorization).toBe(entry.authorization(secret));
      if (entry.rawResponse) {
        const rawRequest = requests[1];
        if (!rawRequest) throw new Error('GitHub Gist raw request was not made');
        expect(String(rawRequest.url)).toBe(
          'https://gist.githubusercontent.com/alice/github-backup/raw/0123456789abcdef0123/axterm-sync-v1.json',
        );
        expect(rawRequest.init?.method).toBe('GET');
        expect(new Headers(rawRequest.init?.headers).has('Authorization')).toBe(false);
        expect(rawRequest.init?.redirect).toBe('error');
      }
    }
  });

  it('preserves opaque WebDAV and raw Custom backup bytes through the Application boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-opaque-backup-'));
    directories.push(directory);
    const remoteBytes = Buffer.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a]);
    const cases = [
      {
        type: 'webdav' as const,
        endpointUrl: 'https://dav.example.test/storage/',
        remoteId: 'legacy.json',
        provider: (fetcher: typeof fetch) => new WebDavSyncProvider(fetcher),
      },
      {
        type: 'custom' as const,
        endpointUrl: 'https://sync.example.test/raw',
        remoteId: 'custom-user',
        provider: (fetcher: typeof fetch) => new CustomSyncProvider(fetcher),
      },
    ];

    for (const entry of cases) {
      const path = join(directory, `${entry.type}-remote.bin`);
      const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe('GET');
        return new Response(remoteBytes, { status: 200 });
      });
      const database = await ProductDatabase.open();
      databases.push(database);
      const repository = new SyncProfileRepository(database);
      const service = new DataSyncService(
        repository,
        [entry.provider(fetcher as typeof fetch)],
        { resolve: async () => 'backup-secret' },
        {
          async resolveGrant(grantId: string) {
            return {
              grantId,
              kind: 'save-target' as const,
              name: `${entry.type}-remote.bin`,
              permissions: ['write'] as const,
              createdAt: new Date().toISOString(),
              path,
            };
          },
        },
        axtermDataSourceFixture(),
      );
      services.push(service);
      const syncProfile = await service.create({
        provider: entry.type,
        name: `${entry.type} raw backup`,
        endpointUrl: entry.endpointUrl,
        remoteId: entry.remoteId,
        username: null,
        accessCredentialRef: 'backup-credential',
        encryptionCredentialRef: null,
        selectedCategories: ['settings'],
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 5,
        autoSyncDirection: 'upload',
      });

      const result = await service.backupRemote(syncProfile.id, 'save-grant');

      expect(await readFile(path)).toEqual(remoteBytes);
      expect(result).toEqual({
        bytes: remoteBytes.byteLength,
        sha256: createHash('sha256').update(remoteBytes).digest('hex'),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('requires a writable save grant and an existing remote object', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-backup-'));
    directories.push(directory);
    const path = join(directory, 'remote-backup.json');
    const context = await fixture(false, path);
    await expect(
      context.service.backupRemote(context.profile.id, 'read-grant'),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(
      context.service.backupRemote(context.profile.id, 'save-grant'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await readdir(directory)).toEqual([]);
    expect(context.repository.get(context.profile.id).state).toBe('idle');
  });

  it('reports a local backup write failure without changing the remote or sync profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-backup-'));
    directories.push(directory);
    const context = await fixture(false, join(directory, 'missing-parent', 'backup.json'));
    await context.service.run(context.profile.id, 'upload');
    const remote = structuredClone(context.provider.remote);
    const profile = context.repository.get(context.profile.id);
    await expect(
      context.service.backupRemote(context.profile.id, 'save-grant'),
    ).rejects.toMatchObject({
      code: 'SYNC_BACKUP_WRITE_FAILED',
    });
    expect(context.provider.remote).toEqual(remote);
    expect(context.repository.get(context.profile.id)).toEqual(profile);
    expect(await readdir(directory)).toEqual([]);
  });

  it('cancels an in-flight remote backup without changing sync state or creating a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-sync-backup-'));
    directories.push(directory);
    const context = await fixture(false, join(directory, 'remote-backup.json'));
    context.provider.hang = true;
    const backup = context.service.backupRemote(context.profile.id, 'save-grant');
    await vi.waitFor(() => expect(context.service.resourceCount()).toBe(1));
    context.service.cancel(context.profile.id);
    await expect(backup).rejects.toMatchObject({ code: 'SYNC_ABORTED' });
    expect(context.service.resourceCount()).toBe(0);
    expect(context.repository.get(context.profile.id).state).toBe('idle');
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects unsupported sync format at storage boundary before network activity', async () => {
    const context = await fixture(true);
    const current = context.repository.getRecord(context.profile.id);
    expect(() =>
      context.database.run(
        "UPDATE sync_profiles SET format='unsupported-v1' WHERE id=?",
        current.id,
      ),
    ).toThrow();
    expect(context.repository.getRecord(current.id)).toEqual(current);
    expect(context.provider.remote).toBeNull();
    expect(context.secrets.get('cred_access')).toBe('ACCESS_TOKEN_SECRET');
  });

  it('uploads and compares Axterm data, then previews and commits through its own contract', async () => {
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
    await expect(context.service.run(context.profile.id, 'download')).rejects.toMatchObject({
      code: 'SYNC_FORMAT_UNSUPPORTED',
    });
    const downloaded = await context.service.previewAxtermDownload(context.profile.id);
    expect(downloaded.profile.state).toBe('download-preview');
    expect(context.service.pendingAxtermDownload(context.profile.id).previewId).toBe(
      downloaded.preview.previewId,
    );
    const committed = await context.service.commitAxtermDownload(
      context.profile.id,
      downloaded.preview.previewId,
    );
    expect(committed).toMatchObject({
      profile: { state: 'idle', pendingPreviewId: null },
      result: { settings: 'applied' },
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

  for (const encrypted of [false, true]) {
    it(`rejects the sanitized historical-source ${encrypted ? 'encrypted' : 'plaintext'} sync fixture without rewriting it`, async () => {
      const fileName = encrypted
        ? 'historical-axterm-sync-encrypted-v1-657b3cc.sanitized.json'
        : 'historical-axterm-sync-plaintext-v1-657b3cc.sanitized.json';
      const expectedSha256 = encrypted
        ? '39e4f8342bb92c73c4d6df919aaf2c03af84b051611c260d4bf1e2123bc81056'
        : '6036e72b2970f97457d13081cbc34aae26d1f570d3c7f237f7dbaf4870679849';
      const contents = await readFile(
        new URL(`../../../../tests/fixtures/migration/${fileName}`, import.meta.url),
        'utf8',
      );
      expect(createHash('sha256').update(contents).digest('hex')).toBe(expectedSha256);
      for (const secret of [
        'historical-package-fixture-password',
        'historical-package-sync-access-secret',
        'historical-package-sync-encryption-secret',
      ])
        expect(contents).not.toContain(secret);

      const context = await fixture(encrypted);
      context.secrets.set('cred_encrypt', 'historical-package-sync-encryption-secret');
      context.provider.remote = {
        contents,
        revision: 'historical-r1',
        updatedAt: '2026-09-23T00:00:00.000Z',
      };
      await expect(context.service.compare(context.profile.id)).rejects.toThrow();
      await expect(context.service.previewAxtermDownload(context.profile.id)).rejects.toThrow();
      expect(context.provider.remote).toMatchObject({
        contents,
        revision: 'historical-r1',
      });
    });
  }

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

  it('uses the independent Axterm source for marked profile comparison and upload', async () => {
    const context = await fixture(false, undefined, axtermDataSourceFixture());
    context.database.run(
      "UPDATE sync_profiles SET format='axterm-sync-v1' WHERE id=?",
      context.profile.id,
    );

    const missing = await context.service.compare(context.profile.id);
    expect(missing).toMatchObject({
      remoteExists: false,
      deviceName: null,
      categories: [
        expect.objectContaining({ category: 'settings', state: 'local-only', localCount: 1 }),
        expect.objectContaining({ category: 'bookmarks', state: 'local-only', localCount: 0 }),
      ],
    });

    await expect(context.service.run(context.profile.id, 'upload')).resolves.toMatchObject({
      profile: { format: 'axterm-sync-v1', state: 'idle' },
      direction: 'upload',
      uploaded: true,
      preview: null,
    });
    const envelope = JSON.parse(context.provider.remote!.contents) as { document: unknown };
    expect(envelope.document).toMatchObject({
      format: 'axterm-sync',
      formatVersion: 1,
      deviceName: 'axterm-sync-test-device',
    });
    expect(JSON.stringify(envelope.document)).not.toContain('_axterm');
    expect(JSON.stringify(envelope.document)).not.toMatch(/credentialRef/u);

    await expect(context.service.compare(context.profile.id)).resolves.toMatchObject({
      remoteExists: true,
      deviceName: 'axterm-sync-test-device',
      categories: [
        expect.objectContaining({ category: 'settings', state: 'equal' }),
        expect.objectContaining({ category: 'bookmarks', state: 'equal' }),
      ],
    });
  });

  it('previews and commits a marked Axterm profile through its separate Contract path', async () => {
    const context = await fixture(false, undefined, axtermDataSourceFixture());
    context.database.run(
      "UPDATE sync_profiles SET format='axterm-sync-v1' WHERE id=?",
      context.profile.id,
    );
    await context.service.run(context.profile.id, 'upload');

    const pending = await context.service.previewAxtermDownload(context.profile.id);
    expect(pending).toMatchObject({
      profile: { format: 'axterm-sync-v1', state: 'download-preview' },
      preview: { settings: 'will-apply', canCommit: true },
    });
    expect(context.service.pendingAxtermDownload(context.profile.id)).toEqual(pending.preview);
    await expect(context.service.run(context.profile.id, 'download')).rejects.toMatchObject({
      code: 'SYNC_FORMAT_UNSUPPORTED',
    });

    await expect(
      context.service.commitAxtermDownload(context.profile.id, pending.preview.previewId),
    ).resolves.toMatchObject({
      profile: { format: 'axterm-sync-v1', state: 'idle', pendingPreviewId: null },
      result: { previewId: pending.preview.previewId, settings: 'applied' },
    });
    expect(() => context.service.pendingAxtermDownload(context.profile.id)).toThrow(
      /No Axterm sync/u,
    );
  });

  it('cancels a marked Axterm preview without calling the legacy source', async () => {
    const context = await fixture(false, undefined, axtermDataSourceFixture());
    context.database.run(
      "UPDATE sync_profiles SET format='axterm-sync-v1' WHERE id=?",
      context.profile.id,
    );
    await context.service.run(context.profile.id, 'upload');
    const pending = await context.service.previewAxtermDownload(context.profile.id);

    expect(context.service.cancelAxtermDownload(context.profile.id)).toMatchObject({
      state: 'idle',
      pendingPreviewId: null,
    });
    expect(() => context.service.pendingAxtermDownload(context.profile.id)).toThrow(
      /No Axterm sync/u,
    );
    await expect(
      context.service.commitAxtermDownload(context.profile.id, pending.preview.previewId),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('does not schedule an Axterm download without an automatic-apply policy', async () => {
    const context = await fixture(false, undefined, axtermDataSourceFixture());
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
    context.database.run(
      "UPDATE sync_profiles SET format='axterm-sync-v1' WHERE id=?",
      context.profile.id,
    );

    await context.service.tick(Date.now() + 61_000);

    expect(context.provider.remote).toBeNull();
    expect(context.repository.get(context.profile.id)).toMatchObject({
      format: 'axterm-sync-v1',
      state: 'idle',
      lastErrorCode: null,
    });
    expect(context.service.resourceCount()).toBe(0);
  });

  it('does not automatically download without an Axterm apply policy', async () => {
    const context = await fixture();
    await context.service.run(context.profile.id, 'upload');
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
    expect(pending).toMatchObject({ state: 'idle', pendingPreviewId: null });
  });
});
