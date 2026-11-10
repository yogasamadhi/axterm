import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { DomainCommands } from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import * as Facts from '../../packages/plugins/terminals/src/facts.ts';
import * as Connections from '../../packages/plugins/connections/src/index.ts';
import * as Automation from '../../packages/plugins/automation/src/index.ts';
import { ConfigurationSyncApplication } from '../../packages/plugins/configuration/src/application/sync.ts';
import { AxtermConfigurationSyncDataSource } from '../../packages/plugins/configuration/src/application/sync-source.ts';
import { SyncEnvelopeCodec } from '../../packages/plugins/configuration/src/application/sync-crypto.ts';
import { OwnedSyncProfiles } from '../../packages/plugins/configuration/src/adapters/sync-profiles.ts';
import { SyncIntents } from '../../packages/plugins/configuration/src/adapters/sync-intents.ts';
import { SyncResourceCoordinator } from '../../packages/plugins/configuration/src/adapters/sync-coordination.ts';
import { syncProfileInputSchema } from '@axterm/plugin-api/configuration-sync';
import type {
  SyncProvider,
  SyncRemoteObject,
} from '../../packages/plugins/configuration/src/ports/sync.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-sync-workflow-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  const generation = randomUUID();
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(DesktopTasks);
  let domain!: RelationalDomain;
  const open = ctx.storage.domain.open.bind(ctx.storage.domain);
  vi.spyOn(ctx.storage.domain, 'open').mockImplementation(async (spec) => {
    const value = await open(spec);
    if (spec.name === 'configuration') domain = value as unknown as RelationalDomain;
    return value;
  });
  await ctx.plugin(Catalog);
  await ctx.plugin(Configuration, { profile: 'workflow' });
  const execute = vi.fn();
  ctx.provide('terminals', {
    executeCommand: async () => {},
    addOutputObserver: () => () => {},
    insertText: execute,
    registerExternal() {
      throw new Error('No terminal');
    },
    enqueueStartupSequence: execute,
    list: () => [],
    workingDirectory: () => {
      throw new Error('No terminal');
    },
    recentOutput: () => {
      throw new Error('No terminal');
    },
    get() {
      throw new Error('No terminal');
    },
    close: async () => {},
    resourceCount: () => 0,
  });
  await ctx.plugin(Facts);
  await ctx.plugin(Connections);
  await ctx.plugin(Automation, { profile: 'workflow' });
  await vi.waitFor(() => expect(ctx.get('configurationPortable')).toBeDefined());
  const source = new AxtermConfigurationSyncDataSource(
    ctx.configurationPortable.application,
    'fixture',
  );
  const profiles = new OwnedSyncProfiles(domain);
  const intents = new SyncIntents(domain, 'workflow', generation);
  const coordinator = new SyncResourceCoordinator(join(home, 'leases'));
  let remote: SyncRemoteObject | null = null;
  const provider: SyncProvider = {
    type: 'webdav',
    load: vi.fn(async () => remote),
    readBackup: vi.fn(async () => (remote ? Buffer.from(remote.contents) : null)),
    save: vi.fn(
      async (_context, contents) =>
        (remote = { contents, revision: '"revision"', updatedAt: new Date().toISOString() }),
    ),
  };
  const backup = {
    write: vi.fn(async (_grant: string, _bytes: Uint8Array, _signal: AbortSignal) => {}),
  };
  const secret = vi.fn(async () => 'fixture-password');
  const app = new ConfigurationSyncApplication(
    domain,
    profiles,
    intents,
    coordinator,
    new DomainCommands(domain, 'axterm_configuration_command_receipts'),
    generation,
    source,
    secret,
    [provider],
    backup,
    false,
  );
  cleanup.push(() => app.close());
  await app.initialize();
  const input = syncProfileInputSchema.parse({
    provider: 'webdav',
    name: 'Sync',
    endpointUrl: 'http://127.0.0.1:8972/dav',
    remoteId: 'data',
    accessCredentialRef: 'cred_' + randomUUID(),
    encryptionCredentialRef: 'cred_' + randomUUID(),
    selectedCategories: ['settings', 'bookmarks'],
  });
  const profile = await app.create(randomUUID(), generation, input);
  return {
    home,
    ctx,
    app,
    domain,
    profiles,
    intents,
    coordinator,
    source,
    provider,
    backup,
    secret,
    profile,
    generation,
    input,
    setRemote: (value: SyncRemoteObject | null) => {
      remote = value;
    },
  };
}
it('preserves encrypted v1 uploads, comparison, backup and one-shot outcomes without secret persistence', async () => {
  const f = await fixture();
  const command = randomUUID();
  const uploaded = await f.app.run(
    command,
    f.generation,
    f.profile.id,
    'upload',
    new AbortController().signal,
  );
  expect(uploaded.receipt.status).toBe('completed');
  expect(uploaded.result?.operation).toBe('upload');
  const saved = vi.mocked(f.provider.save).mock.calls[0]![1];
  const envelope = JSON.parse(saved);
  expect(envelope).toMatchObject({
    formatVersion: 1,
    encrypted: true,
    algorithm: 'aes-256-gcm+scrypt',
  });
  expect(saved).not.toContain('fixture-password');
  const codec = new SyncEnvelopeCodec(f.secret);
  expect((await codec.decode(saved, f.profiles.getRecord(f.profile.id))).deviceName).toBe(
    'fixture',
  );
  expect(await f.app.outcome(command)).toEqual(uploaded);
  expect(() =>
    f.app.run(command, f.generation, f.profile.id, 'upload', new AbortController().signal),
  ).toThrow('ALREADY_SUBMITTED');
  expect(f.provider.save).toHaveBeenCalledTimes(1);
  const comparison = await f.app.run(
    randomUUID(),
    f.generation,
    f.profile.id,
    'compare',
    new AbortController().signal,
  );
  expect(
    comparison.result?.operation === 'compare' &&
      comparison.result.value.categories.every((item) => item.state === 'equal'),
  ).toBe(true);
  const backup = await f.app.run(
    randomUUID(),
    f.generation,
    f.profile.id,
    'backup',
    new AbortController().signal,
    'save-grant',
  );
  expect(backup.receipt.status).toBe('completed');
  expect(f.backup.write).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.domain.all('SELECT * FROM axterm_sync_run_intents'))).not.toContain(
    'fixture-password',
  );
  expect(JSON.stringify(f.app.snapshot())).not.toContain('accessCredentialRef');
});
it('joins late canceled provider work before releasing shared ownership or closing SQL', async () => {
  const f = await fixture();
  const late = Promise.withResolvers<SyncRemoteObject | null>();
  vi.mocked(f.provider.load).mockImplementationOnce(() => late.promise);
  const command = randomUUID();
  const run = f.app.run(command, f.generation, f.profile.id, 'test', new AbortController().signal);
  await vi.waitFor(() => expect(f.provider.load).toHaveBeenCalled());
  f.app.cancel(command);
  let closed = false;
  const closing = f.app.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.app.active()).toBe(true);
  late.resolve(null);
  expect((await run).receipt).toMatchObject({ status: 'failed', reason: 'cancelled' });
  await closing;
  expect(f.app.active()).toBe(false);
  expect(() => f.app.snapshot()).toThrow('CLOSED');
});
it('records uncertain writes and suspends automatic uploads instead of retrying a lost commit response', async () => {
  const f = await fixture();
  await f.app.update(randomUUID(), f.generation, f.profile.id, { autoSyncEnabled: true }, '"v1"');
  vi.mocked(f.provider.save).mockRejectedValueOnce(new Error('lost response PRIVATE'));
  const command = randomUUID();
  const outcome = await f.app.run(
    command,
    f.generation,
    f.profile.id,
    'upload',
    new AbortController().signal,
  );
  expect(outcome.receipt).toMatchObject({ status: 'uncertain', reason: 'uncertain' });
  expect(f.profiles.get(f.profile.id).autoSyncEnabled).toBe(false);
  await f.app.tick(performance.now() + 60 * 60_000);
  expect(f.provider.save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.intents.list())).not.toContain('PRIVATE');
});
it('atomically commits imported facts, sync state and receipt, retaining a preview after rollback', async () => {
  const f = await fixture();
  await f.app.run(randomUUID(), f.generation, f.profile.id, 'upload', new AbortController().signal);
  const previewOutcome = await f.app.run(
    randomUUID(),
    f.generation,
    f.profile.id,
    'download-preview',
    new AbortController().signal,
  );
  if (previewOutcome.result?.operation !== 'download-preview') throw new Error('No preview');
  const previewId = previewOutcome.result.value.preview.previewId;
  const before = f.ctx.configurationPortable.application.snapshot();
  const original = f.profiles.setRunState.bind(f.profiles);
  vi.spyOn(f.profiles, 'setRunState').mockImplementationOnce(() => {
    throw new Error('finalize failure');
  });
  const command = randomUUID();
  await expect(f.app.commit(command, f.generation, f.profile.id, previewId)).rejects.toThrow(
    'finalize failure',
  );
  expect(f.source.getPreview(previewId)).not.toBeNull();
  expect(f.profiles.get(f.profile.id).state).toBe('download-preview');
  expect(f.ctx.configurationPortable.application.snapshot().data).toEqual(before.data);
  vi.mocked(f.profiles.setRunState).mockImplementation(original);
  const result = await f.app.commit(command, f.generation, f.profile.id, previewId);
  expect(result.profile.state).toBe('idle');
  expect(f.source.getPreview(previewId)).toBeNull();
  expect(await f.app.commit(command, f.generation, f.profile.id, previewId)).toEqual(result);
  expect(f.provider.save).toHaveBeenCalledTimes(1);
});
it('does not catch up past intervals on activation and never deletes shared Vault records', async () => {
  const f = await fixture();
  await f.app.update(
    randomUUID(),
    f.generation,
    f.profile.id,
    { autoSyncEnabled: true, autoSyncIntervalMinutes: 1 },
    '"v1"',
  );
  await f.app.tick(performance.now());
  expect(f.provider.save).not.toHaveBeenCalled();
  await f.app.tick(performance.now() + 60_001);
  expect(f.provider.save).toHaveBeenCalledTimes(1);
  const current = f.profiles.get(f.profile.id);
  await f.app.remove(randomUUID(), f.generation, current.id, '"v' + current.version + '"');
  expect(f.profiles.list()).toEqual([]);
});

it('round-trips the owned workflow through a real authenticated WebDAV provider', async () => {
  const { createServer } = await import('node:http');
  const { WebDavSyncProvider } =
    await import('../../packages/plugins/configuration/src/adapters/sync-providers.ts');
  let bytes: Buffer | undefined;
  let puts = 0;
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method!);
    if (!request.headers.authorization?.startsWith('Basic ')) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.method === 'MKCOL') {
      response.writeHead(201);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      if (!bytes) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { etag: '"real-' + puts + '"', 'content-type': 'application/json' });
      response.end(bytes);
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
      puts++;
      response.writeHead(201, { etag: '"real-' + puts + '"' });
      response.end();
      return;
    }
    response.writeHead(405);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const f = await fixture();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    f.profiles.update(
      f.profile.id,
      { endpointUrl: 'http://127.0.0.1:' + address.port + '/dav' },
      '"v1"',
    );
    const real = new WebDavSyncProvider();
    vi.mocked(f.provider.load).mockImplementation((...args) => real.load(...args));
    vi.mocked(f.provider.save).mockImplementation((...args) => real.save(...args));
    vi.mocked(f.provider.readBackup).mockImplementation((...args) => real.readBackup(...args));
    const uploaded = await f.app.run(
      randomUUID(),
      f.generation,
      f.profile.id,
      'upload',
      new AbortController().signal,
    );
    expect(uploaded.receipt.status).toBe('completed');
    expect(puts).toBe(1);
    const compared = await f.app.run(
      randomUUID(),
      f.generation,
      f.profile.id,
      'compare',
      new AbortController().signal,
    );
    expect(
      compared.result?.operation === 'compare' &&
        compared.result.value.categories.every((item) => item.state === 'equal'),
    ).toBe(true);
    const previewed = await f.app.run(
      randomUUID(),
      f.generation,
      f.profile.id,
      'download-preview',
      new AbortController().signal,
    );
    if (previewed.result?.operation !== 'download-preview')
      throw new Error('Missing download preview');
    const result = await f.app.commit(
      randomUUID(),
      f.generation,
      f.profile.id,
      previewed.result.value.preview.previewId,
    );
    expect(result.profile.state).toBe('idle');
    expect(puts).toBe(1);
    expect(methods).toContain('MKCOL');
    expect(JSON.parse(bytes!.toString()).encrypted).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it('backs up raw bytes including empty objects without changing a pending download preview or sync state', async () => {
  const f = await fixture();
  await f.app.run(randomUUID(), f.generation, f.profile.id, 'upload', new AbortController().signal);
  const downloaded = await f.app.run(
    randomUUID(),
    f.generation,
    f.profile.id,
    'download-preview',
    new AbortController().signal,
  );
  if (downloaded.result?.operation !== 'download-preview') throw new Error('Missing preview');
  const before = f.profiles.get(f.profile.id);
  for (const bytes of [new Uint8Array(), Uint8Array.from([0xff, 0x00, 0x7b, 0xc3, 0x28, 0x0a])]) {
    vi.mocked(f.provider.readBackup).mockResolvedValueOnce(bytes);
    const outcome = await f.app.run(
      randomUUID(),
      f.generation,
      f.profile.id,
      'backup',
      new AbortController().signal,
      'save',
    );
    expect(outcome.receipt.status).toBe('completed');
    expect(f.backup.write).toHaveBeenLastCalledWith('save', bytes, expect.any(AbortSignal));
    expect(f.profiles.get(f.profile.id)).toEqual(before);
    expect(f.app.pendingPreview(f.profile.id).previewId).toBe(
      downloaded.result.value.preview.previewId,
    );
  }
});
for (const encrypted of [false, true])
  it(
    'rejects frozen historical ' +
      (encrypted ? 'encrypted' : 'plaintext') +
      ' input without rewriting the remote',
    async () => {
      const { readFile } = await import('node:fs/promises');
      const contents = await readFile(
        new URL(
          '../fixtures/migration/historical-axterm-sync-' +
            (encrypted ? 'encrypted' : 'plaintext') +
            '-v1-657b3cc.sanitized.json',
          import.meta.url,
        ),
        'utf8',
      );
      const f = await fixture();
      f.secret.mockResolvedValue('historical-package-sync-encryption-secret');
      f.setRemote({ contents, revision: 'historical', updatedAt: new Date().toISOString() });
      for (const operation of ['compare', 'download-preview'] as const) {
        const outcome = await f.app.run(
          randomUUID(),
          f.generation,
          f.profile.id,
          operation,
          new AbortController().signal,
        );
        expect(outcome.receipt).toMatchObject({ status: 'failed', reason: 'remote-invalid' });
        expect(f.provider.save).not.toHaveBeenCalled();
      }
    },
  );

it('recovers abandoned runs only under a real shared lease, suspends automatic replay, and keeps nonce tombstones', async () => {
  const f = await fixture();
  await f.app.update(randomUUID(), f.generation, f.profile.id, { autoSyncEnabled: true }, '"v1"');
  const command = randomUUID();
  const current = f.profiles.get(f.profile.id);
  f.intents.reserve(command, f.generation, current.id, 'upload', current.version);
  await f.coordinator.withResource(current.id, async (lease) => {
    f.intents.running(command, lease);
    f.profiles.setRunState(current.id, { state: 'uploading', pendingPreviewId: null });
  });
  await f.app.initialize();
  expect(f.intents.outcome(command).receipt).toMatchObject({
    status: 'interrupted',
    reason: 'interrupted',
  });
  expect(f.profiles.get(current.id)).toMatchObject({
    state: 'failed',
    autoSyncEnabled: false,
    lastErrorCode: 'SYNC_INTERRUPTED',
  });
  await f.app.tick(performance.now() + 60 * 60_000);
  expect(f.provider.load).not.toHaveBeenCalled();
  expect(f.provider.save).not.toHaveBeenCalled();
  expect(() =>
    f.app.run(command, f.generation, current.id, 'upload', new AbortController().signal),
  ).toThrow('ALREADY_SUBMITTED');
});

it('excludes another Profile through actual drain and avoids a second automatic upload after shared completion', async () => {
  const f = await fixture();
  await f.app.update(
    randomUUID(),
    f.generation,
    f.profile.id,
    { autoSyncEnabled: true, autoSyncIntervalMinutes: 1 },
    '"v1"',
  );
  const generation = randomUUID();
  const otherIntents = new SyncIntents(f.domain, 'second-profile', generation);
  const other = new ConfigurationSyncApplication(
    f.domain,
    f.profiles,
    otherIntents,
    new SyncResourceCoordinator(join(f.home, 'leases')),
    new DomainCommands(f.domain, 'axterm_configuration_command_receipts'),
    generation,
    f.source,
    f.secret,
    [f.provider],
    f.backup,
    false,
  );
  cleanup.push(() => other.close());
  const late = Promise.withResolvers<SyncRemoteObject>();
  vi.mocked(f.provider.save).mockImplementationOnce(() => late.promise);
  const first = f.app.run(
    randomUUID(),
    f.generation,
    f.profile.id,
    'upload',
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.provider.save).toHaveBeenCalledTimes(1));
  await other.initialize();
  const blocked = await other.run(
    randomUUID(),
    generation,
    f.profile.id,
    'upload',
    new AbortController().signal,
  );
  expect(blocked.receipt).toMatchObject({ status: 'failed', reason: 'conflict' });
  expect(f.provider.save).toHaveBeenCalledTimes(1);
  late.resolve({
    contents: 'not-consumed-by-save',
    revision: 'completed',
    updatedAt: new Date().toISOString(),
  });
  expect((await first).receipt.status).toBe('completed');
  await other.tick(performance.now() + 60_001);
  expect(f.provider.save).toHaveBeenCalledTimes(1);
});
