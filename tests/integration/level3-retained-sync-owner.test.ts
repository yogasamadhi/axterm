import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DomainCommands } from '@axterm/infra-storage-domain';
import {
  syncProfileInputSchema,
  type SyncOperation,
  type SyncProfileInput,
} from '@axterm/plugin-api/configuration-sync';
import { configurationFixture } from '../fixtures/level3-configuration.ts';
import { ConfigurationSyncApplication } from '../../packages/plugins/configuration/src/application/sync.ts';
import { AxtermConfigurationSyncDataSource } from '../../packages/plugins/configuration/src/application/sync-source.ts';
import { OwnedSyncProfiles } from '../../packages/plugins/configuration/src/adapters/sync-profiles.ts';
import { SyncIntents } from '../../packages/plugins/configuration/src/adapters/sync-intents.ts';
import { SyncResourceCoordinator } from '../../packages/plugins/configuration/src/adapters/sync-coordination.ts';
import { SyncBackupFiles } from '../../packages/plugins/configuration/src/adapters/sync-backup.ts';
import { SyncApplicationError } from '../../packages/plugins/configuration/src/application/sync-errors.ts';
import {
  CustomSyncProvider,
  GistSyncProvider,
  WebDavSyncProvider,
} from '../../packages/plugins/configuration/src/adapters/sync-providers.ts';
import type {
  SyncProvider,
  SyncProviderContext,
  SyncRemoteObject,
} from '../../packages/plugins/configuration/src/ports/sync.ts';
class MemoryProvider implements SyncProvider {
  readonly type = 'custom' as const;
  remote: SyncRemoteObject | null = null;
  backupBytes: Uint8Array | null = null;
  hang = false;
  readonly save = vi.fn(
    async (
      _context: SyncProviderContext,
      contents: string,
      expected: string | null,
      _signal: AbortSignal,
    ) => {
      if ((this.remote?.revision ?? null) !== expected)
        throw new SyncApplicationError('SYNC_REMOTE_CONFLICT', 'Remote changed', 412);
      return (this.remote = {
        contents,
        revision: 'revision-' + randomUUID(),
        updatedAt: new Date().toISOString(),
      });
    },
  );
  readonly load = vi.fn(async (_context: SyncProviderContext, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (this.hang)
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    return this.remote;
  });
  async readBackup(context: SyncProviderContext, signal: AbortSignal) {
    const remote = await this.load(context, signal);
    return remote ? (this.backupBytes ?? Buffer.from(remote.contents)) : null;
  }
}
async function fixture(
  encrypted = false,
  supplied?: { provider: SyncProvider; secret: string; input: Partial<SyncProfileInput> },
  additionalProviders: readonly SyncProvider[] = [],
) {
  const f = await configurationFixture(true),
    domain = f.handles.get('configuration')!,
    generation = f.ctx.runtimeIdentity.generation;
  const memory = new MemoryProvider(),
    provider = supplied?.provider ?? memory;
  const secrets = new Map([
    ['cred_access', supplied?.secret ?? 'ACCESS_TOKEN_SECRET'],
    ['cred_encrypt', 'SYNC_ENCRYPTION_PASSWORD'],
  ]);
  const profiles = new OwnedSyncProfiles(domain);
  const app = new ConfigurationSyncApplication(
    domain,
    profiles,
    new SyncIntents(domain, 'retained-sync', generation),
    new SyncResourceCoordinator(join(f.managed!.home, 'leases')),
    new DomainCommands(domain, 'axterm_configuration_command_receipts'),
    generation,
    new AxtermConfigurationSyncDataSource(f.app, 'axterm-sync-test-device'),
    async (ref) => {
      const secret = secrets.get(ref);
      if (!secret) throw new Error('credential missing');
      return secret;
    },
    [provider, ...additionalProviders],
    new SyncBackupFiles(() => f.ctx.files),
    false,
  );
  f.onClose(() => app.close());
  await app.initialize();
  const input = syncProfileInputSchema.parse({
    provider: provider.type,
    name: 'Test provider',
    endpointUrl: 'https://sync.example.test/api/',
    remoteId: 'user-1',
    accessCredentialRef: 'cred_access',
    encryptionCredentialRef: encrypted ? 'cred_encrypt' : null,
    selectedCategories: ['settings', 'bookmarks'],
    ...supplied?.input,
  });
  const profile = await app.create(randomUUID(), generation, input);
  const directory = join(f.managed!.home, 'backup');
  await mkdir(directory, { mode: 0o700 });
  return {
    ...f,
    app,
    source: f.app,
    domain,
    generation,
    profiles,
    memory,
    provider,
    secrets,
    profile,
    input,
    directory,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(
  f: Fixture,
  operation: SyncOperation,
  grantId?: string,
  command = randomUUID(),
  profile = f.profile.id,
) {
  return f.app.run(
    command,
    f.generation,
    profile,
    operation,
    new AbortController().signal,
    grantId,
  );
}
async function saveGrant(f: Fixture, path: string) {
  return (await f.managed!.capabilities.registry.createTrustedPath(path, 'save-target', ['write']))
    .grantId;
}

describe('Configuration owned sync retained witnesses', () => {
  it('backs up each built-in provider payload through the same save-grant boundary', async () => {
    const root = await configurationFixture(true);
    const directory = join(root.managed!.home, 'provider-backups');
    await mkdir(directory);
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
      const context = await fixture(false, {
        provider: entry.provider(fetcher as typeof fetch),
        secret: secret,
        input: {
          provider: entry.type,
          name: entry.type + ' backup',
          endpointUrl: entry.endpointUrl,
          remoteId: entry.remoteId,
          selectedCategories: ['settings'],
        },
      });
      const outcome = await run(context, 'backup', await saveGrant(context, path));
      expect(outcome.receipt.status).toBe('completed');
      if (outcome.result?.operation !== 'backup') throw new Error('Missing backup');
      const result = outcome.result.value;

      expect(await readFile(path)).toEqual(Buffer.from(remotePayload, 'utf8'));
      expect(result).toEqual({
        bytes: Buffer.byteLength(remotePayload),
        sha256: createHash('sha256').update(remotePayload).digest('hex'),
      });
      expect(context.profiles.get(context.profile.id).state).toBe('idle');
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
    const root = await configurationFixture(true);
    const directory = join(root.managed!.home, 'opaque-backups');
    await mkdir(directory);
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
      const context = await fixture(false, {
        provider: entry.provider(fetcher as typeof fetch),
        secret: 'backup-secret',
        input: {
          provider: entry.type,
          name: entry.type + ' backup',
          endpointUrl: entry.endpointUrl,
          remoteId: entry.remoteId,
          selectedCategories: ['settings'],
        },
      });
      const outcome = await run(context, 'backup', await saveGrant(context, path));
      expect(outcome.receipt.status).toBe('completed');
      if (outcome.result?.operation !== 'backup') throw new Error('Missing backup');
      const result = outcome.result.value;

      expect(await readFile(path)).toEqual(remoteBytes);
      expect(result).toEqual({
        bytes: remoteBytes.byteLength,
        sha256: createHash('sha256').update(remoteBytes).digest('hex'),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves encrypted pending previews and opaque byte-stream backups through actual save authority', async () => {
    const f = await fixture(true);
    expect((await run(f, 'upload')).receipt.status).toBe('completed');
    const original = f.memory.remote!.contents;
    expect(original).not.toContain('SYNC_ENCRYPTION_PASSWORD');
    const preview = await run(f, 'download-preview');
    if (preview.result?.operation !== 'download-preview') throw Error('Missing preview');
    const before = f.profiles.get(f.profile.id);
    for (const [name, bytes] of [
      ['remote-backup.json', Buffer.from(original)],
      ['remote-backup.bin', Buffer.from([0xff, 0, 0x7b, 0xc3, 0x28, 0x0a])],
    ] as const) {
      f.memory.backupBytes = bytes;
      const path = join(f.directory, name),
        outcome = await run(f, 'backup', await saveGrant(f, path));
      expect(outcome.receipt.status).toBe('completed');
      expect(outcome.result).toEqual({
        operation: 'backup',
        value: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      });
      expect(await readFile(path)).toEqual(bytes);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(f.memory.remote!.contents).toBe(original);
      expect(f.profiles.get(f.profile.id)).toEqual(before);
      expect(f.app.pendingPreview(f.profile.id).previewId).toBe(
        preview.result.value.preview.previewId,
      );
    }
    expect(await readdir(f.directory)).toEqual(['remote-backup.bin', 'remote-backup.json']);
  });
  it('refuses read-only backups, missing remote objects and revoked save authority without changing profile or remote', async () => {
    const f = await fixture();
    const path = join(f.directory, 'remote-backup.json');
    expect((await run(f, 'backup', await saveGrant(f, path))).receipt).toMatchObject({
      status: 'failed',
      reason: 'not-found',
    });
    expect(await readdir(f.directory)).toEqual([]);
    expect(f.profiles.get(f.profile.id).state).toBe('idle');
    expect((await run(f, 'upload')).receipt.status).toBe('completed');
    const before = f.profiles.get(f.profile.id),
      remote = structuredClone(f.memory.remote);
    const readOnly = join(f.managed!.home, 'read-only.json');
    await writeFile(readOnly, '{}');
    const grant = await f.managed!.capabilities.registry.createTrustedPath(readOnly, 'file', [
      'read',
    ]);
    expect((await run(f, 'backup', grant.grantId)).receipt).toMatchObject({
      status: 'uncertain',
      reason: 'uncertain',
    });
    await expect(
      saveGrant(f, join(f.directory, 'missing-parent', 'backup.json')),
    ).rejects.toThrow();
    const revoked = await saveGrant(f, path);
    f.managed!.capabilities.registry.revoke(revoked);
    expect((await run(f, 'backup', revoked)).receipt).toMatchObject({
      status: 'uncertain',
      reason: 'uncertain',
    });
    expect(f.profiles.get(f.profile.id)).toEqual(before);
    expect(f.memory.remote).toEqual(remote);
    expect(await readdir(f.directory)).toEqual([]);
    expect(await readFile(readOnly, 'utf8')).toBe('{}');
  });
  it('joins cancellation of backup and comparison and persists only current redacted failure codes', async () => {
    const f = await fixture();
    for (const operation of ['backup', 'compare'] as const) {
      f.memory.hang = true;
      const command = randomUUID(),
        before = f.profiles.get(f.profile.id);
      const pending = run(
        f,
        operation,
        operation === 'backup' ? await saveGrant(f, join(f.directory, 'backup.json')) : undefined,
        command,
      );
      await vi.waitFor(() => expect(f.memory.load.mock.calls.length).toBeGreaterThan(0));
      f.app.cancel(command);
      const outcome = await pending;
      expect(outcome.receipt).toMatchObject({ status: 'failed', reason: 'cancelled' });
      expect(f.app.active()).toBe(false);
      if (operation === 'backup') expect(f.profiles.get(f.profile.id)).toEqual(before);
      else
        expect(f.profiles.get(f.profile.id)).toMatchObject({
          state: 'failed',
          lastErrorCode: 'SYNC_CANCELLED',
        });
      expect(JSON.stringify(f.profiles.get(f.profile.id))).not.toContain('ACCESS_TOKEN_SECRET');
      expect(await readdir(f.directory)).toEqual([]);
      f.memory.load.mockClear();
    }
  });
  it('rejects an unsupported persisted format before network activity', async () => {
    const f = await fixture(true),
      before = f.profiles.getRecord(f.profile.id);
    expect(() =>
      f.domain.run("UPDATE sync_profiles SET format='unsupported-v1' WHERE id=?", f.profile.id),
    ).toThrow();
    expect(f.profiles.getRecord(f.profile.id)).toEqual(before);
    expect(f.memory.load).not.toHaveBeenCalled();
    expect(f.memory.save).not.toHaveBeenCalled();
    expect(f.secrets.get('cred_access')).toBe('ACCESS_TOKEN_SECRET');
  });
  it('compares and uploads only the independent source then explicitly previews, commits and cancels downloads', async () => {
    const f = await fixture();
    const missing = await run(f, 'compare');
    expect(missing.result).toMatchObject({
      operation: 'compare',
      value: {
        remoteExists: false,
        deviceName: null,
        categories: [
          { category: 'settings', state: 'local-only', localCount: 1 },
          { category: 'bookmarks', state: 'local-only', localCount: 0 },
        ],
      },
    });
    const uploaded = await run(f, 'upload');
    expect(uploaded.result).toMatchObject({
      operation: 'upload',
      value: {
        profile: { format: 'axterm-sync-v1', state: 'idle' },
        direction: 'upload',
        uploaded: true,
        preview: null,
      },
    });
    expect(JSON.stringify(uploaded)).not.toContain('cred_access');
    const envelope = JSON.parse(f.memory.remote!.contents);
    expect(envelope.document).toMatchObject({
      format: 'axterm-sync',
      formatVersion: 1,
      deviceName: 'axterm-sync-test-device',
    });
    expect(JSON.stringify(envelope.document)).not.toContain('_axterm');
    expect(JSON.stringify(envelope.document)).not.toMatch(/credentialRef/u);
    expect((await run(f, 'compare')).result).toMatchObject({
      operation: 'compare',
      value: {
        remoteExists: true,
        deviceName: 'axterm-sync-test-device',
        categories: [
          { category: 'settings', state: 'equal' },
          { category: 'bookmarks', state: 'equal' },
        ],
      },
    });
    await expect(run(f, 'download' as never)).rejects.toThrow();
    const pending = await run(f, 'download-preview');
    if (pending.result?.operation !== 'download-preview') throw Error('Missing preview');
    expect(pending.result.value).toMatchObject({
      profile: { format: 'axterm-sync-v1', state: 'download-preview' },
      preview: { settings: 'will-apply', canCommit: true },
    });
    expect(f.app.pendingPreview(f.profile.id)).toEqual(pending.result.value.preview);
    const committed = await f.app.commit(
      randomUUID(),
      f.generation,
      f.profile.id,
      pending.result.value.preview.previewId,
    );
    expect(committed).toMatchObject({
      profile: { state: 'idle', pendingPreviewId: null },
      result: { previewId: pending.result.value.preview.previewId, settings: 'applied' },
    });
    expect(() => f.app.pendingPreview(f.profile.id)).toThrow('SYNC_NOT_FOUND');
    const canceled = await run(f, 'download-preview');
    if (canceled.result?.operation !== 'download-preview') throw Error('Missing preview');
    expect(await f.app.cancelDownload(randomUUID(), f.generation, f.profile.id)).toMatchObject({
      state: 'idle',
      pendingPreviewId: null,
    });
    expect(() => f.app.pendingPreview(f.profile.id)).toThrow('SYNC_NOT_FOUND');
    await expect(
      f.app.commit(
        randomUUID(),
        f.generation,
        f.profile.id,
        canceled.result.value.preview.previewId,
      ),
    ).rejects.toThrow();
  });
  it('encrypts actual settings and refuses a missing decryption reference without leaking its values', async () => {
    const f = await fixture(true);
    f.ctx.configurationController.updateSettings(
      randomUUID(),
      { fileManager: { externalEditor: 'LOCAL_SETTINGS_MARKER' } },
      '"v1"',
    );
    expect((await run(f, 'upload')).receipt.status).toBe('completed');
    expect(f.memory.remote!.contents).not.toContain('LOCAL_SETTINGS_MARKER');
    expect(f.memory.remote!.contents).not.toContain('SYNC_ENCRYPTION_PASSWORD');
    await f.app.update(
      randomUUID(),
      f.generation,
      f.profile.id,
      { clearEncryptionCredential: true },
      '"v' + f.profiles.get(f.profile.id).version + '"',
    );
    expect((await run(f, 'compare')).receipt).toMatchObject({
      status: 'failed',
      reason: 'not-configured',
    });
  });
  it('runs at most two due automatic uploads and never automatically downloads or applies', async () => {
    const extra = ['github', 'webdav'].map((type) => {
      const control = new MemoryProvider();
      const provider: SyncProvider = {
        type: type as 'github' | 'webdav',
        load: control.load,
        save: control.save,
        readBackup: control.readBackup.bind(control),
      };
      return { control, provider };
    });
    const f = await fixture(
      false,
      undefined,
      extra.map((value) => value.provider),
    );
    await f.app.update(
      randomUUID(),
      f.generation,
      f.profile.id,
      { autoSyncEnabled: true, autoSyncIntervalMinutes: 1 },
      '"v1"',
    );
    for (const [index, name] of ['Second', 'Third'].entries())
      await f.app.create(randomUUID(), f.generation, {
        ...f.input,
        provider: extra[index]!.provider.type,
        name,
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 1,
      });
    const controls = [f.memory, ...extra.map((value) => value.control)];
    await f.app.tick(performance.now());
    expect(controls.reduce((sum, c) => sum + c.save.mock.calls.length, 0)).toBe(0);
    await f.app.tick(performance.now() + 60_001);
    expect(controls.reduce((sum, c) => sum + c.save.mock.calls.length, 0)).toBe(2);
    expect(f.profiles.list().filter((p) => p.lastSyncAt !== null)).toHaveLength(2);
    expect(
      f.profiles
        .list()
        .filter((p) => p.lastSyncAt !== null)
        .every((p) => p.state === 'idle' && p.lastErrorCode === null),
    ).toBe(true);
    const current = f.profiles.get(f.profile.id);
    await f.app.update(
      randomUUID(),
      f.generation,
      f.profile.id,
      { autoSyncDirection: 'download' },
      '"v' + current.version + '"',
    );
    for (const p of f.profiles.list().filter((p) => p.id !== f.profile.id))
      await f.app.update(
        randomUUID(),
        f.generation,
        p.id,
        { autoSyncEnabled: false },
        '"v' + p.version + '"',
      );
    for (const remoteExists of [false, true]) {
      if (remoteExists) expect((await run(f, 'upload')).receipt.status).toBe('completed');
      for (const c of controls) {
        c.save.mockClear();
        c.load.mockClear();
      }
      await f.app.tick(performance.now() + 120_001);
      for (const c of controls) {
        expect(c.save).not.toHaveBeenCalled();
        expect(c.load).not.toHaveBeenCalled();
      }
      expect(f.profiles.get(f.profile.id)).toMatchObject({
        format: 'axterm-sync-v1',
        state: 'idle',
        pendingPreviewId: null,
        lastErrorCode: null,
      });
      expect(f.app.active()).toBe(false);
    }
  });
  it('keeps offline provider diagnostics out of public outcomes and persistent state', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1 ACCESS_TOKEN_SECRET');
    });
    const f = await fixture(false, {
      provider: new WebDavSyncProvider(fetcher as typeof fetch),
      secret: 'ACCESS_TOKEN_SECRET',
      input: { provider: 'webdav', endpointUrl: 'http://127.0.0.1:8972/dav', remoteId: 'offline' },
    });
    expect((await run(f, 'test')).receipt).toMatchObject({
      status: 'failed',
      reason: 'unavailable',
    });
    expect(f.profiles.get(f.profile.id)).toMatchObject({
      state: 'failed',
      lastErrorCode: 'SYNC_UNAVAILABLE',
    });
    const persisted = JSON.stringify({
      profile: f.profiles.get(f.profile.id),
      intents: f.domain.all('SELECT * FROM axterm_sync_run_intents'),
    });
    for (const hidden of ['ECONNREFUSED', 'ACCESS_TOKEN_SECRET', '127.0.0.1 ACCESS'])
      expect(persisted).not.toContain(hidden);
  });
  for (const encrypted of [false, true]) {
    it(`refuses frozen historical-source ${encrypted ? 'encrypted' : 'plaintext'} input without rewriting it`, async () => {
      const name = encrypted
        ? 'historical-axterm-sync-encrypted-v1-657b3cc.sanitized.json'
        : 'historical-axterm-sync-plaintext-v1-657b3cc.sanitized.json';
      const sha = encrypted
        ? '39e4f8342bb92c73c4d6df919aaf2c03af84b051611c260d4bf1e2123bc81056'
        : '6036e72b2970f97457d13081cbc34aae26d1f570d3c7f237f7dbaf4870679849';
      const contents = await readFile(
        new URL('../fixtures/migration/' + name, import.meta.url),
        'utf8',
      );
      expect(createHash('sha256').update(contents).digest('hex')).toBe(sha);
      for (const secret of [
        'historical-package-fixture-password',
        'historical-package-sync-access-secret',
        'historical-package-sync-encryption-secret',
      ])
        expect(contents).not.toContain(secret);
      const f = await fixture(encrypted);
      f.secrets.set('cred_encrypt', 'historical-package-sync-encryption-secret');
      f.memory.remote = {
        contents,
        revision: 'historical-r1',
        updatedAt: '2026-09-23T00:00:00.000Z',
      };
      for (const operation of ['compare', 'download-preview'] as const)
        expect((await run(f, operation)).receipt).toMatchObject({
          status: 'failed',
          reason: 'remote-invalid',
        });
      expect(f.memory.remote).toMatchObject({ contents, revision: 'historical-r1' });
      expect(f.memory.save).not.toHaveBeenCalled();
    });
  }
});
