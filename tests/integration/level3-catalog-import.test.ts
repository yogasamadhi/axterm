import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { parseSshConfig } from '../../packages/plugins/catalog/src/application/host-import-service.ts';
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type {
  CatalogImportChunk,
  SshConfigImportPreview,
  SshConfigImportResult,
} from '@axterm/plugin-api/catalog';
import {
  sshConfigImportPreviewSchema,
  sshConfigImportResultSchema,
} from '@axterm/plugin-api/catalog';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const files = await createManagedImportFixture();
  cleanups.push(() => files.close());
  const ctx: Context = files.ctx;
  ctx.provide('files', files.files);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, {
    path: join(files.home, 'catalog.sqlite'),
    schema: 'productSchema',
  });
  await ctx.plugin(Domains, { backend: 'relational' });
  const facility = ctx.storage.domain,
    open = facility.open.bind(facility);
  let facts: RelationalDomain | undefined;
  vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
    const handle = await open(spec);
    if (spec.name === 'catalog' && 'participant' in handle)
      facts = handle as unknown as RelationalDomain;
    return handle;
  });
  let owner = ctx.plugin(Catalog);
  await owner;
  return {
    ...files,
    ctx,
    controller: () => ctx.catalogController,
    facts: () => {
      if (!facts) throw Error('Catalog handle not captured');
      return facts;
    },
    async restart() {
      await owner.dispose();
      owner = ctx.plugin(Catalog);
      await owner;
    },
  };
}
async function read<T>(
  stream: AsyncIterable<CatalogImportChunk>,
  parse: (value: unknown) => T,
): Promise<T> {
  let offset = 0;
  let final = false;
  const chunks: string[] = [];
  for await (const item of stream) {
    expect(final).toBe(false);
    expect(item.offset).toBe(offset);
    expect(item.text.length).toBeLessThanOrEqual(16_384);
    offset += item.text.length;
    final = item.final;
    chunks.push(item.text);
  }
  expect(final).toBe(true);
  return parse(JSON.parse(chunks.join('')));
}
const live = () => new AbortController().signal;
const preview = (ctx: Context, grantId: string) =>
  read(ctx.catalogController.previewSshConfigImport({ grantId }, live()), (value) =>
    sshConfigImportPreviewSchema.parse(value),
  );
const report = (ctx: Context, id: string) =>
  read(ctx.catalogController.getSshConfigImportReport(id, live()), (value) =>
    sshConfigImportResultSchema.parse(value),
  );
const command = (value: SshConfigImportPreview) => ({
  previewId: value.previewId,
  groupId: null as string | null,
  items: value.items.flatMap((item) => (item.draft ? [item.draft] : [])),
});
async function source(f: Awaited<ReturnType<typeof fixture>>, name: string, content: string) {
  const path = join(f.home, name);
  await writeFile(path, content);
  return f.capabilities.registry.createTrustedPath(path, 'file', ['read']);
}
it('uses explicit Include authorities, keeps edited drafts, atomically commits and durably replays without files or preview', async () => {
  const f = await fixture();
  const root = await source(
    f,
    'config',
    'Host gateway\n HostName gateway.example\n User operator\nInclude private.d/*.conf\nHost app\n HostName app.example\n User operator\n ProxyJump gateway\n IdentityFile /PRIVATE_KEY_MUST_NOT_BE_READ\n',
  );
  await mkdir(join(f.home, 'includes'));
  await writeFile(
    join(f.home, 'includes', 'extra.conf'),
    'Host extra\n HostName extra.example\n User operator\n',
  );
  const directory = await f.capabilities.registry.createTrustedPath(
    join(f.home, 'includes'),
    'directory',
    ['read'],
  );
  const first = await preview(f.ctx, root.grantId);
  expect(first.items).toHaveLength(2);
  expect(first.includes[0]).toMatchObject({ status: 'authorization-required', pattern: '*.conf' });
  expect(
    first.items
      .flatMap((item) => item.notices)
      .some((item) => item.code === 'IDENTITY_FILE_NOT_IMPORTED'),
  ).toBe(true);
  const authorized = await read(
    f.controller().previewSshConfigImport(
      {
        grantId: root.grantId,
        includeGrants: [{ includeId: first.includes[0]!.id, grantId: directory.grantId }],
      },
      live(),
    ),
    (value) => sshConfigImportPreviewSchema.parse(value),
  );
  expect(authorized.items).toHaveLength(3);
  expect(authorized.includes[0]).toMatchObject({ status: 'authorized', fileCount: 1 });
  expect(JSON.stringify(authorized)).not.toContain(f.home);
  const input = command(authorized);
  input.items = input.items.map((item) =>
    item.name === 'app' ? { ...item, title: 'Reviewed application' } : item,
  );
  const key = randomUUID();
  const etag = f.controller().getBookmarkTree().etag;
  const receipt = f.controller().commitSshConfigImport(key, input, etag);
  expect(receipt.summary).toMatchObject({ imported: 3, linked: 0 });
  const result = await report(f.ctx, receipt.reportId);
  expect(result.tree.bookmarks.some((item) => item.title === 'Reviewed application')).toBe(true);
  const app = result.createdHosts.find((item) => item.name === 'app')!;
  expect(app.jumpHostId).toBe(result.createdHosts.find((item) => item.name === 'gateway')!.id);
  await f.ctx.fileGrants.revoke(root.grantId);
  await f.ctx.fileGrants.revoke(directory.grantId);
  await f.restart();
  expect(f.controller().commitSshConfigImport(key, input, etag)).toEqual(receipt);
  expect(await report(f.ctx, receipt.reportId)).toEqual(result);
  expect(f.controller().listHosts()).toHaveLength(3);
});
it('preserves the preview across stale-tree and report-write rollback, then retries the same uncommitted key', async () => {
  const f = await fixture();
  const grant = await source(f, 'config', 'Host retry\n User operator\n');
  const prepared = await preview(f.ctx, grant.grantId);
  const input = command(prepared);
  const key = randomUUID();
  const stale = f.controller().getBookmarkTree().etag;
  f.controller().createBookmarkGroup(randomUUID(), { name: 'Concurrent' }, stale);
  expect(() => f.controller().commitSshConfigImport(key, input, stale)).toThrowError(
    expect.objectContaining({
      details: { reason: 'precondition-failed', diagnostic: { code: 'PRECONDITION_FAILED' } },
    }),
  );
  expect(f.controller().listHosts()).toEqual([]);
  const etag = f.controller().getBookmarkTree().etag;
  const original = CatalogStorage.prototype.run;
  let wroteReport = false;
  const failure = vi.spyOn(CatalogStorage.prototype, 'run').mockImplementation(function (
    this: CatalogStorage,
    sql,
    ...args
  ) {
    if (sql.startsWith('INSERT INTO axterm_catalog_import_reports')) {
      original.call(this, sql, ...args);
      wroteReport = true;
      throw new Error('DISK_FAILURE_CANARY');
    }
    return original.call(this, sql, ...args);
  });
  expect(() => f.controller().commitSshConfigImport(key, input, etag)).toThrow(
    'The catalog operation failed',
  );
  expect(f.controller().listHosts()).toEqual([]);
  expect(f.controller().getBookmarkTree().etag).toBe(etag);
  expect(wroteReport).toBe(true);
  expect(f.facts().all('SELECT report_id FROM axterm_catalog_import_reports')).toEqual([]);
  failure.mockRestore();
  const receipt = f.controller().commitSshConfigImport(key, input, etag);
  expect(receipt.summary.imported).toBe(1);
  expect((await report(f.ctx, receipt.reportId)).createdHosts).toHaveLength(1);
});
it('streams reports larger than the compact journal limit without losing host or item details', async () => {
  const f = await fixture();
  const grant = await source(
    f,
    'config',
    Array.from({ length: 1000 }, (_, index) => `Host h${index}\n User operator\n`).join(''),
  );
  const prepared = await preview(f.ctx, grant.grantId);
  const input = command(prepared);
  input.items = input.items.map((item) => ({ ...item, description: 'd'.repeat(1024) }));
  const receipt = f
    .controller()
    .commitSshConfigImport(randomUUID(), input, f.controller().getBookmarkTree().etag);
  expect(receipt.summary.imported).toBe(1000);
  const result: SshConfigImportResult = await report(f.ctx, receipt.reportId);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1024 * 1024);
  expect(result.createdHosts).toHaveLength(1000);
  expect(result.items).toHaveLength(1000);
  expect(result.tree.bookmarks.every((item) => item.description.length === 1024)).toBe(true);
});
it('expires only bounded full reports while retaining compact retry outcomes and explicitly denies absent authority', async () => {
  const f = await fixture();
  let first:
    | {
        key: string;
        input: ReturnType<typeof command>;
        etag: string;
        receipt: ReturnType<ReturnType<typeof f.controller>['commitSshConfigImport']>;
      }
    | undefined;
  for (let index = 0; index < 9; index++) {
    const grant = await source(f, `config-${index}`, `Host h${index}\n User operator\n`);
    const prepared = await preview(f.ctx, grant.grantId);
    const input = command(prepared);
    const key = randomUUID();
    const etag = f.controller().getBookmarkTree().etag;
    const receipt = f.controller().commitSshConfigImport(key, input, etag);
    first ??= { key, input, etag, receipt };
  }
  await expect(report(f.ctx, first!.receipt.reportId)).rejects.toMatchObject({
    details: { reason: 'not-found' },
  });
  expect(f.controller().commitSshConfigImport(first!.key, first!.input, first!.etag)).toEqual(
    first!.receipt,
  );
  await expect(preview(f.ctx, 'not-a-grant')).rejects.toThrow();
});

it('detects explicitly authorized Include cycles and rejects unrelated bindings without following private paths', async () => {
  const f = await fixture();
  const root = await source(
    f,
    'config',
    'Include ~/.ssh/private/*.conf\nHost root\n User operator\n',
  );
  const child = await source(
    f,
    'child.conf',
    'Include C:\\private\\config\nHost child\n User operator\n',
  );
  const first = await preview(f.ctx, root.grantId);
  const bindings = [{ includeId: first.includes[0]!.id, grantId: child.grantId }];
  const second = await read(
    f
      .controller()
      .previewSshConfigImport({ grantId: root.grantId, includeGrants: bindings }, live()),
    (value) => sshConfigImportPreviewSchema.parse(value),
  );
  const nested = second.includes.find((item) => item.status === 'authorization-required')!;
  const complete = await read(
    f.controller().previewSshConfigImport(
      {
        grantId: root.grantId,
        includeGrants: [...bindings, { includeId: nested.id, grantId: root.grantId }],
      },
      live(),
    ),
    (value) => sshConfigImportPreviewSchema.parse(value),
  );
  expect(complete.items.map((item) => item.alias)).toEqual(['child', 'root']);
  expect(complete.includes.some((item) => item.notice?.code === 'INCLUDE_CYCLE_SKIPPED')).toBe(
    true,
  );
  expect(JSON.stringify(complete)).not.toContain('C:\\private');
  await expect(
    read(
      f.controller().previewSshConfigImport(
        {
          grantId: root.grantId,
          includeGrants: [{ includeId: 'unrelated', grantId: child.grantId }],
        },
        live(),
      ),
      (value) => value,
    ),
  ).rejects.toMatchObject({ details: { reason: 'invalid-input' } });
});

const chainConfig = `
Include ~/.ssh/conf.d/*
Host *
  User deploy
  Port 2222
  ServerAliveInterval 30

Host bastion-a
  HostName a.example.test
  IdentityFile ~/.ssh/id_ed25519

Host bastion-b
  HostName b.example.test
  ProxyJump bastion-a

Host app
  HostName app.example.test
  ProxyJump deploy@a.example.test:2222,bastion-b
  ProxyCommand unsafe-command %h %p
`;

function catalogEvents(f: Awaited<ReturnType<typeof fixture>>) {
  return f.facts();
}
it('retains original three-host jump chain, one tree revision, notices and unchanged repeated import through confirmed previews', async () => {
  const f = await fixture(),
    root = await source(f, 'config', chainConfig),
    events = await catalogEvents(f);
  let tree = f.controller().getBookmarkTree();
  f.controller().createBookmarkGroup(randomUUID(), { name: 'SSH Config' }, tree.etag);
  tree = f.controller().getBookmarkTree();
  const group = tree.groups[0]!;
  const before = events.events(0).length,
    prepared = await preview(f.ctx, root.grantId);
  expect(prepared.includes).toEqual([
    expect.objectContaining({ status: 'authorization-required', pattern: '*' }),
  ]);
  const receipt = f
      .controller()
      .commitSshConfigImport(randomUUID(), { ...command(prepared), groupId: group.id }, tree.etag),
    imported = await report(f.ctx, receipt.reportId);
  expect(imported.summary).toEqual({
    total: 3,
    imported: 3,
    linked: 0,
    unchanged: 0,
    skipped: 0,
    warningCount: 3,
  });
  expect(imported.createdHosts).toHaveLength(3);
  expect(imported.createdBookmarks).toHaveLength(3);
  expect(imported.tree.revision).toBe(tree.revision + 1);
  expect(imported.tree.bookmarks.every(({ groupId }) => groupId === group.id)).toBe(true);
  const byName = new Map(
    f
      .controller()
      .listHosts()
      .map((host) => [host.name, host]),
  );
  expect(byName.get('bastion-a')?.jumpHostId).toBeNull();
  expect(byName.get('bastion-b')?.jumpHostId).toBe(byName.get('bastion-a')?.id);
  expect(byName.get('app')?.jumpHostId).toBe(byName.get('bastion-b')?.id);
  expect(byName.get('app')?.connectionOptions.keepaliveIntervalMs).toBe(30000);
  expect(imported.items.find(({ alias }) => alias === 'bastion-a')?.notices).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'IDENTITY_FILE_NOT_IMPORTED' })]),
  );
  expect(imported.items.find(({ alias }) => alias === 'app')?.notices).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'PROXY_COMMAND_NOT_IMPORTED' })]),
  );
  expect(
    events
      .events(0)
      .slice(before)
      .map(({ type }) => type),
  ).toEqual(['host.created', 'host.created', 'host.created', 'bookmark.batch-created']);
  const beforeRepeat = events.events(0),
    again = await preview(f.ctx, root.grantId);
  const repeatedReceipt = f.controller().commitSshConfigImport(
      randomUUID(),
      {
        ...command(again),
        groupId: group.id,
        items: command(again).items.map((item) => ({ ...item, selected: true })),
      },
      imported.tree.etag,
    ),
    repeated = await report(f.ctx, repeatedReceipt.reportId);
  expect(repeated.summary).toMatchObject({ imported: 0, linked: 0, unchanged: 3, skipped: 0 });
  expect(repeated.createdHosts).toEqual([]);
  expect(repeated.createdBookmarks).toEqual([]);
  expect(repeated.tree).toEqual(imported.tree);
  expect(events.events(0)).toEqual(beforeRepeat);
});
it('retains compatible saved Host linking once and all three duplicate or unsupported entry notices', async () => {
  const f = await fixture();
  const existing = f.controller().createHost(randomUUID(), {
    name: 'gateway',
    hostname: 'gateway.example.test',
    port: 22,
    username: 'operator',
    authType: 'agent',
    favorite: true,
  });
  const root = await source(
    f,
    'config',
    'Host gateway\n HostName gateway.example.test\n User operator\nHost gateway\n HostName gateway.example.test\n User operator\nHost *.internal\n User operator\nHost one two\n User operator\n',
  );
  const before = f.controller().getBookmarkTree(),
    prepared = await preview(f.ctx, root.grantId),
    receipt = f.controller().commitSshConfigImport(randomUUID(), command(prepared), before.etag),
    result = await report(f.ctx, receipt.reportId);
  expect(result.summary).toMatchObject({
    total: 4,
    imported: 0,
    linked: 1,
    unchanged: 0,
    skipped: 3,
  });
  expect(result.createdHosts).toEqual([]);
  expect(result.createdBookmarks).toHaveLength(1);
  expect(result.createdBookmarks[0]?.hostId).toBe(existing.ids[0]);
  expect(result.tree.revision).toBe(before.revision + 1);
  expect(result.items.map(({ status }) => status)).toEqual([
    'linked',
    'skipped',
    'skipped',
    'skipped',
  ]);
  expect(result.items.flatMap(({ notices }) => notices.map(({ code }) => code))).toEqual(
    expect.arrayContaining([
      'DUPLICATE_ALIAS_SKIPPED',
      'WILDCARD_HOST_SKIPPED',
      'MULTI_ALIAS_HOST_SKIPPED',
    ]),
  );
});
it.each([
  [
    'missing',
    'Host application\n HostName application.example.test\n User operator\n ProxyJump missing-gateway\n',
    'MISSING_PROXY_JUMP',
  ],
  [
    'cycle',
    'Host gateway-a\n HostName a.example.test\n User operator\n ProxyJump gateway-b\nHost gateway-b\n HostName b.example.test\n User operator\n ProxyJump gateway-a\n',
    'PROXY_JUMP_CYCLE',
  ],
] as const)(
  'retains %s ProxyJump refusal before any Catalog facts, revisions or events commit',
  async (_name, text, code) => {
    const f = await fixture(),
      root = await source(f, 'config', text),
      events = await catalogEvents(f),
      before = f.controller().getBookmarkTree(),
      prior = events.events(0),
      prepared = await preview(f.ctx, root.grantId);
    expect(prepared.items.every(({ status }) => status === 'skipped')).toBe(true);
    expect(prepared.items.flatMap(({ notices }) => notices.map(({ code }) => code))).toContain(
      code,
    );
    const input = command(prepared);
    input.items = input.items.map((item) => ({ ...item, selected: true }));
    expect(() =>
      f.controller().commitSshConfigImport(randomUUID(), input, before.etag),
    ).toThrowError(
      expect.objectContaining({
        details: { reason: 'conflict', diagnostic: { code: 'CONFLICT' } },
      }),
    );
    expect(f.controller().listHosts()).toEqual([]);
    expect(f.controller().getBookmarkTree()).toEqual(before);
    expect(events.events(0)).toEqual(prior);
  },
);
it('retains the original one MiB SSH source bound before preview or Catalog writes', async () => {
  const f = await fixture(),
    path = join(f.home, 'config');
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x61));
  const root = await f.capabilities.registry.createTrustedPath(path, 'file', ['read']);
  const before = f.controller().getBookmarkTree(),
    events = await catalogEvents(f),
    prior = events.events(0);
  await expect(preview(f.ctx, root.grantId)).rejects.toMatchObject({
    code: 'catalog/failure',
    details: { reason: 'invalid-input' },
  });
  expect(f.controller().listHosts()).toEqual([]);
  expect(f.controller().getBookmarkTree()).toEqual(before);
  expect(events.events(0)).toEqual(prior);
});
it('retains basename-only Include patterns without absolute, home-relative or Windows private paths in preview metadata', async () => {
  const f = await fixture(),
    root = await source(
      f,
      'config',
      'Include /Users/alice/.ssh/private/*.conf ~/.ssh/also/*.cfg C:\\Users\\alice\\.ssh\\secret\\*.inc\nHost safe\n HostName safe.example.test\n User operator\n',
    );
  const prepared = await preview(f.ctx, root.grantId);
  expect(prepared.includes.map(({ pattern }) => pattern)).toEqual(['*.conf', '*.cfg', '*.inc']);
  const serialized = JSON.stringify(prepared);
  for (const denied of ['/Users/alice', '~/.ssh', 'C:\\Users', 'private', 'secret'])
    expect(serialized).not.toContain(denied);
});

describe('owned parseSshConfig', () => {
  it('uses Host star defaults, equals syntax, inline comments and bounded ProxyJump lists', () => {
    expect(
      parseSshConfig(`
Host *
  User = deploy
  Port 2200
Host gateway
  HostName gateway.example.test # safe comment
Host app
  HostName "app#blue.example.test"
  ProxyJump gateway
`),
    ).toEqual([
      expect.objectContaining({
        name: 'gateway',
        hostname: 'gateway.example.test',
        username: 'deploy',
        port: 2200,
      }),
      expect.objectContaining({
        name: 'app',
        hostname: 'app#blue.example.test',
        username: 'deploy',
        port: 2200,
        proxyJump: 'gateway',
      }),
    ]);
  });
});

it('retains independently authorized nested Includes, edited hostname/title, all SSH defaults and one atomic tree commit', async () => {
  const f = await fixture(),
    root = await source(
      f,
      'config',
      `Include conf.d/*.conf
Host *
 User deploy
 ConnectTimeout 12
 ServerAliveInterval 7
 ServerAliveCountMax 4
 Compression no
 ConnectionAttempts 3
Host app
 HostName app.example.test
 ProxyJump gateway
`,
    );
  await mkdir(join(f.home, 'conf.d'));
  await writeFile(
    join(f.home, 'conf.d/gateway.conf'),
    'Include ../nested.conf\nHost gateway\n HostName gateway.example.test\n User jump\n',
  );
  const folder = await f.capabilities.registry.createTrustedPath(
    join(f.home, 'conf.d'),
    'directory',
    ['read'],
  );
  const nested = await source(
    f,
    'nested.conf',
    'Host audit\n HostName audit.example.test\n User audit\n',
  );
  const rootOnly = await preview(f.ctx, root.grantId);
  expect(rootOnly.includes).toEqual([
    expect.objectContaining({
      id: 'root/i0-0',
      status: 'authorization-required',
      pattern: '*.conf',
    }),
  ]);
  expect(rootOnly.items.find(({ alias }) => alias === 'app')).toMatchObject({
    status: 'skipped',
    draft: { selected: false },
  });
  const first = await read(
    f.controller().previewSshConfigImport(
      {
        grantId: root.grantId,
        includeGrants: [{ includeId: 'root/i0-0', grantId: folder.grantId }],
      },
      live(),
    ),
    (value) => sshConfigImportPreviewSchema.parse(value),
  );
  expect(first.includes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'root/i0-0', status: 'authorized', fileCount: 1 }),
      expect.objectContaining({ id: 'root/i0-0/f0/i0-0', status: 'authorization-required' }),
    ]),
  );
  expect(first.items.map(({ alias }) => alias)).toEqual(['gateway', 'app']);
  const complete = await read(
    f.controller().previewSshConfigImport(
      {
        grantId: root.grantId,
        includeGrants: [
          { includeId: 'root/i0-0', grantId: folder.grantId },
          { includeId: 'root/i0-0/f0/i0-0', grantId: nested.grantId },
        ],
      },
      live(),
    ),
    (value) => sshConfigImportPreviewSchema.parse(value),
  );
  expect(complete.items.map(({ alias }) => alias)).toEqual(['audit', 'gateway', 'app']);
  expect(complete.summary).toMatchObject({ imported: 3, skipped: 0, selected: 3 });
  const input = command(complete);
  input.items = input.items.map((draft) =>
    draft.name === 'app'
      ? {
          ...draft,
          title: 'Production application',
          description: 'Imported through an authorized Include chain',
          hostname: 'app.internal.example',
        }
      : draft,
  );
  const stale = f.controller().getBookmarkTree();
  f.controller().createBookmarkGroup(randomUUID(), { name: 'Imported' }, stale.etag);
  const current = f.controller().getBookmarkTree();
  input.groupId = current.groups[0]!.id;
  expect(() => f.controller().commitSshConfigImport(randomUUID(), input, stale.etag)).toThrowError(
    expect.objectContaining({
      details: { reason: 'precondition-failed', diagnostic: { code: 'PRECONDITION_FAILED' } },
    }),
  );
  expect(f.controller().listHosts()).toEqual([]);
  const receipt = f.controller().commitSshConfigImport(randomUUID(), input, current.etag),
    result = await report(f.ctx, receipt.reportId);
  expect(result.summary).toMatchObject({ imported: 3, linked: 0, skipped: 0 });
  expect(result.tree.revision).toBe(current.revision + 1);
  expect(
    result.tree.bookmarks.find(({ title }) => title === 'Production application'),
  ).toMatchObject({ description: 'Imported through an authorized Include chain' });
  const byName = new Map(
    f
      .controller()
      .listHosts()
      .map((host) => [host.name, host]),
  );
  expect(byName.get('app')).toMatchObject({
    hostname: 'app.internal.example',
    authType: 'agent',
    connectionOptions: {
      connectionTimeoutMs: 12000,
      keepaliveIntervalMs: 7000,
      keepaliveCountMax: 4,
      compression: false,
      reconnectPolicy: { mode: 'automatic', delayMs: 3000, maxAttempts: 3 },
    },
  });
  expect(byName.get('app')?.jumpHostId).toBe(byName.get('gateway')?.id);
  expect(() =>
    f
      .controller()
      .commitSshConfigImport(randomUUID(), { ...input, groupId: null }, result.tree.etag),
  ).toThrowError(
    expect.objectContaining({
      details: { reason: 'precondition-failed', diagnostic: { code: 'PRECONDITION_FAILED' } },
    }),
  );
});

it('retains whole-batch conflict refusal after a new candidate without partial Hosts, Bookmarks, revisions or events', async () => {
  const f = await fixture(),
    root = await source(
      f,
      'config',
      'Host first\n HostName first.example.test\n User operator\nHost fail\n HostName fail.example.test\n User operator\n',
    ),
    prepared = await preview(f.ctx, root.grantId),
    before = f.controller().getBookmarkTree();
  f.controller().commitSshConfigImport(randomUUID(), command(prepared), before.etag);
  const tree = f.controller().getBookmarkTree(),
    hosts = f.controller().listHosts(),
    events = f.facts().events(0);
  await writeFile(
    join(f.home, 'config'),
    'Host new-entry\n HostName new.example.test\n User operator\nHost first\n HostName changed.example.test\n User operator\n',
  );
  const changed = await preview(f.ctx, root.grantId),
    input = command(changed);
  input.items = input.items.map((item) => ({ ...item, selected: true }));
  expect(() => f.controller().commitSshConfigImport(randomUUID(), input, tree.etag)).toThrowError(
    expect.objectContaining({ details: { reason: 'conflict', diagnostic: { code: 'CONFLICT' } } }),
  );
  expect(f.controller().listHosts()).toEqual(hosts);
  expect(f.controller().getBookmarkTree()).toEqual(tree);
  expect(f.facts().events(0)).toEqual(events);
});
