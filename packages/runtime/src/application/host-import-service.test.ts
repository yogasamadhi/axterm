import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sshConfigImportResultSchema } from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { BookmarkTreeService } from './bookmark-tree-service';
import { HostImportService, parseSshConfig } from './host-import-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-host-import-'));
  directories.push(directory);
  const path = join(directory, 'config');
  await writeFile(path, source, 'utf8');
  const database = await ProductDatabase.open();
  const hosts = new ProductRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const capability = {
    resolveGrant: async () => ({
      grantId: 'ssh-config-grant',
      kind: 'file' as const,
      name: 'config',
      permissions: ['read' as const],
      createdAt: '2026-09-12T00:00:00.000Z',
      path,
    }),
  } satisfies Pick<HostCapabilityClient, 'resolveGrant'>;
  const service = new HostImportService(capability, database, hosts, bookmarks);
  return { database, hosts, bookmarks, service, path };
}

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

describe('HostImportService', () => {
  it('imports one Host and Bookmark per entry in one revision and preserves a jump chain', async () => {
    const { database, hosts, bookmarks, service } = await fixture(chainConfig);
    try {
      let tree = bookmarks.snapshot();
      tree = bookmarks.createGroup({ name: 'SSH Config' }, tree.etag);
      const group = tree.groups[0]!;
      const eventCount = hosts.listEvents().length;

      const imported = sshConfigImportResultSchema.parse(
        await service.import({ grantId: 'ssh-config-grant', groupId: group.id }, tree.etag),
      );

      expect(imported.summary).toEqual({
        total: 3,
        imported: 3,
        linked: 0,
        unchanged: 0,
        skipped: 0,
        warningCount: 3,
      });
      expect(imported.notices).toEqual([
        expect.objectContaining({ code: 'INCLUDE_NOT_FOLLOWED', line: 2 }),
      ]);
      expect(imported.createdHosts).toHaveLength(3);
      expect(imported.createdBookmarks).toHaveLength(3);
      expect(imported.tree.revision).toBe(tree.revision + 1);
      expect(imported.tree.bookmarks).toHaveLength(3);
      expect(imported.tree.bookmarks.every(({ groupId }) => groupId === group.id)).toBe(true);

      const byName = new Map(hosts.listHosts().map((host) => [host.name, host]));
      expect(byName.get('bastion-a')?.jumpHostId).toBeNull();
      expect(byName.get('bastion-b')?.jumpHostId).toBe(byName.get('bastion-a')?.id);
      expect(byName.get('app')?.jumpHostId).toBe(byName.get('bastion-b')?.id);
      expect(byName.get('app')?.connectionOptions.keepaliveIntervalMs).toBe(30_000);
      expect(imported.items.find(({ alias }) => alias === 'bastion-a')?.notices).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'IDENTITY_FILE_NOT_IMPORTED' })]),
      );
      expect(imported.items.find(({ alias }) => alias === 'app')?.notices).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'PROXY_COMMAND_NOT_IMPORTED' })]),
      );
      expect(
        hosts
          .listEvents()
          .slice(eventCount)
          .map(({ type }) => type),
      ).toEqual(['host.created', 'host.created', 'host.created', 'bookmark.batch-created']);

      const beforeRepeatEvents = hosts.listEvents();
      const repeated = sshConfigImportResultSchema.parse(
        await service.import(
          { grantId: 'ssh-config-grant', groupId: group.id },
          imported.tree.etag,
        ),
      );
      expect(repeated.summary).toMatchObject({
        imported: 0,
        linked: 0,
        unchanged: 3,
        skipped: 0,
      });
      expect(repeated.createdHosts).toEqual([]);
      expect(repeated.createdBookmarks).toEqual([]);
      expect(repeated.tree).toEqual(imported.tree);
      expect(hosts.listEvents()).toEqual(beforeRepeatEvents);
    } finally {
      database.close();
    }
  });

  it('links an existing compatible Host once and reports duplicate and unsupported entries', async () => {
    const source = `
Host gateway
  HostName gateway.example.test
  User operator
Host gateway
  HostName gateway.example.test
  User operator
Host *.internal
  User operator
Host one two
  User operator
`;
    const { database, hosts, bookmarks, service } = await fixture(source);
    try {
      const existing = hosts.createHost({
        groupId: null,
        name: 'gateway',
        hostname: 'gateway.example.test',
        port: 22,
        username: 'operator',
        authType: 'agent',
        credentialRef: null,
        passphraseCredentialRef: null,
        jumpHostId: null,
        favorite: true,
      });
      const before = bookmarks.snapshot();
      const result = await service.import(
        { grantId: 'ssh-config-grant', groupId: null },
        before.etag,
      );

      expect(result.summary).toMatchObject({
        total: 4,
        imported: 0,
        linked: 1,
        unchanged: 0,
        skipped: 3,
      });
      expect(result.createdHosts).toEqual([]);
      expect(result.createdBookmarks).toHaveLength(1);
      expect(result.createdBookmarks[0]?.hostId).toBe(existing.id);
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
    } finally {
      database.close();
    }
  });

  it('rolls back Hosts, Bookmarks, tree revision and events on stale, conflict or late failure', async () => {
    const { database, hosts, bookmarks, service, path } = await fixture(`
Host first
  HostName first.example.test
  User operator
Host fail
  HostName fail.example.test
  User operator
`);
    try {
      const stale = bookmarks.snapshot();
      const current = bookmarks.createGroup({ name: 'Changed elsewhere' }, stale.etag);
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, stale.etag),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', status: 412 });
      expect(hosts.listHosts()).toEqual([]);

      database.run(`CREATE TRIGGER fail_import_bookmark
        BEFORE INSERT ON bookmarks WHEN NEW.title='fail'
        BEGIN SELECT RAISE(ABORT, 'forced bookmark import failure'); END`);
      const eventsBeforeFailure = hosts.listEvents();
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, current.etag),
      ).rejects.toThrow('forced bookmark import failure');
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(current);
      expect(hosts.listEvents()).toEqual(eventsBeforeFailure);
      database.run('DROP TRIGGER fail_import_bookmark');

      const successful = await service.import(
        { grantId: 'ssh-config-grant', groupId: null },
        current.etag,
      );
      const beforeConflict = {
        hosts: hosts.listHosts(),
        tree: successful.tree,
        events: hosts.listEvents(),
      };
      await writeFile(
        path,
        `
Host new-entry
  HostName new.example.test
  User operator
Host first
  HostName changed.example.test
  User operator
`,
        'utf8',
      );
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, successful.tree.etag),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(hosts.listHosts()).toEqual(beforeConflict.hosts);
      expect(bookmarks.snapshot()).toEqual(beforeConflict.tree);
      expect(hosts.listEvents()).toEqual(beforeConflict.events);
    } finally {
      database.close();
    }
  });

  it('rejects missing and cyclic ProxyJump references before committing the batch', async () => {
    const { database, hosts, bookmarks, service, path } = await fixture(`
Host application
  HostName application.example.test
  User operator
  ProxyJump missing-gateway
`);
    try {
      const before = bookmarks.snapshot();
      const beforeEvents = hosts.listEvents();
      const missingPreview = await service.preview({ grantId: 'ssh-config-grant' });
      expect(missingPreview.items[0]).toMatchObject({
        status: 'skipped',
        draft: { selected: false },
        notices: [expect.objectContaining({ code: 'MISSING_PROXY_JUMP' })],
      });
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, before.etag),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(before);
      expect(hosts.listEvents()).toEqual(beforeEvents);

      await writeFile(
        path,
        `
Host gateway-a
  HostName a.example.test
  User operator
  ProxyJump gateway-b
Host gateway-b
  HostName b.example.test
  User operator
  ProxyJump gateway-a
`,
        'utf8',
      );
      const cyclePreview = await service.preview({ grantId: 'ssh-config-grant' });
      expect(cyclePreview.items).toHaveLength(2);
      expect(cyclePreview.items.every(({ status }) => status === 'skipped')).toBe(true);
      expect(cyclePreview.items.flatMap(({ notices }) => notices.map(({ code }) => code))).toEqual(
        expect.arrayContaining(['PROXY_JUMP_CYCLE']),
      );
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, before.etag),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(before);
      expect(hosts.listEvents()).toEqual(beforeEvents);

      await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x61));
      await expect(
        service.import({ grantId: 'ssh-config-grant', groupId: null }, before.etag),
      ).rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('previews independently granted nested Includes, accepts edits and commits the confirmed tree atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-host-import-preview-'));
    directories.push(directory);
    const configPath = join(directory, 'config');
    const includeDirectory = join(directory, 'conf.d');
    const gatewayPath = join(includeDirectory, 'gateway.conf');
    const nestedPath = join(directory, 'nested.conf');
    await mkdir(includeDirectory);
    await writeFile(
      configPath,
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
    await writeFile(
      gatewayPath,
      `Include ../nested.conf
Host gateway
  HostName gateway.example.test
  User jump
`,
    );
    await writeFile(
      nestedPath,
      `Host audit
  HostName audit.example.test
  User audit
`,
    );
    const grants = new Map([
      ['root', { kind: 'file' as const, name: 'config', path: configPath }],
      ['includes', { kind: 'directory' as const, name: 'conf.d', path: includeDirectory }],
      ['nested', { kind: 'file' as const, name: 'nested.conf', path: nestedPath }],
    ]);
    const database = await ProductDatabase.open();
    const hosts = new ProductRepository(database);
    const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
    const capability = {
      resolveGrant: async (grantId: string) => {
        const grant = grants.get(grantId);
        if (!grant) throw new Error('missing grant');
        return {
          grantId,
          kind: grant.kind,
          name: grant.name,
          permissions: ['read' as const],
          createdAt: '2026-09-12T00:00:00.000Z',
          path: grant.path,
        };
      },
    } satisfies Pick<HostCapabilityClient, 'resolveGrant'>;
    const service = new HostImportService(capability, database, hosts, bookmarks);
    try {
      const rootOnly = await service.preview({ grantId: 'root' });
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

      const firstInclude = await service.preview({
        grantId: 'root',
        includeGrants: [{ includeId: 'root/i0-0', grantId: 'includes' }],
      });
      expect(firstInclude.includes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'root/i0-0', status: 'authorized', fileCount: 1 }),
          expect.objectContaining({
            id: 'root/i0-0/f0/i0-0',
            status: 'authorization-required',
          }),
        ]),
      );
      expect(firstInclude.items.map(({ alias }) => alias)).toEqual(['gateway', 'app']);

      const complete = await service.preview({
        grantId: 'root',
        includeGrants: [
          { includeId: 'root/i0-0', grantId: 'includes' },
          { includeId: 'root/i0-0/f0/i0-0', grantId: 'nested' },
        ],
      });
      expect(complete.items.map(({ alias }) => alias)).toEqual(['audit', 'gateway', 'app']);
      expect(complete.summary).toMatchObject({ imported: 3, skipped: 0, selected: 3 });
      const drafts = complete.items.flatMap(({ draft }) => (draft ? [draft] : []));
      const edited = drafts.map((draft) =>
        draft.name === 'app'
          ? {
              ...draft,
              title: 'Production application',
              description: 'Imported through an authorized Include chain',
              hostname: 'app.internal.example',
            }
          : draft,
      );
      const stale = bookmarks.snapshot();
      const current = bookmarks.createGroup({ name: 'Imported' }, stale.etag);
      expect(() =>
        service.commitPreview(
          { previewId: complete.previewId, groupId: current.groups[0]!.id, items: edited },
          stale.etag,
        ),
      ).toThrow('Bookmark tree changed');
      expect(hosts.listHosts()).toEqual([]);

      const result = service.commitPreview(
        { previewId: complete.previewId, groupId: current.groups[0]!.id, items: edited },
        current.etag,
      );
      expect(result.summary).toMatchObject({ imported: 3, linked: 0, skipped: 0 });
      expect(result.tree.revision).toBe(current.revision + 1);
      expect(
        result.tree.bookmarks.find(({ title }) => title === 'Production application'),
      ).toMatchObject({ description: 'Imported through an authorized Include chain' });
      const byName = new Map(hosts.listHosts().map((host) => [host.name, host]));
      expect(byName.get('app')).toMatchObject({
        hostname: 'app.internal.example',
        authType: 'agent',
        connectionOptions: {
          connectionTimeoutMs: 12_000,
          keepaliveIntervalMs: 7_000,
          keepaliveCountMax: 4,
          compression: false,
          reconnectPolicy: { mode: 'automatic', delayMs: 3_000, maxAttempts: 3 },
        },
      });
      expect(byName.get('app')?.jumpHostId).toBe(byName.get('gateway')?.id);
      expect(() =>
        service.commitPreview(
          { previewId: complete.previewId, groupId: null, items: edited },
          result.tree.etag,
        ),
      ).toThrow(/preview expired/i);
    } finally {
      database.close();
    }
  });

  it('reports an Include cycle without reading the repeated root file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-host-import-cycle-'));
    directories.push(directory);
    const rootPath = join(directory, 'config');
    const childPath = join(directory, 'child.conf');
    await writeFile(rootPath, 'Include child.conf\nHost root\n User root\n');
    await writeFile(childPath, 'Include config\nHost child\n User child\n');
    const paths = new Map([
      ['root', rootPath],
      ['child', childPath],
    ]);
    const database = await ProductDatabase.open();
    const hosts = new ProductRepository(database);
    const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
    const capability = {
      resolveGrant: async (grantId: string) => ({
        grantId,
        kind: 'file' as const,
        name: basenameForTest(paths.get(grantId)!),
        permissions: ['read' as const],
        createdAt: '2026-09-12T00:00:00.000Z',
        path: paths.get(grantId)!,
      }),
    } satisfies Pick<HostCapabilityClient, 'resolveGrant'>;
    const service = new HostImportService(capability, database, hosts, bookmarks);
    try {
      const preview = await service.preview({
        grantId: 'root',
        includeGrants: [
          { includeId: 'root/i0-0', grantId: 'child' },
          { includeId: 'root/i0-0/f0/i0-0', grantId: 'root' },
        ],
      });
      expect(preview.includes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'root/i0-0/f0/i0-0',
            status: 'skipped',
            notice: expect.objectContaining({ code: 'INCLUDE_CYCLE_SKIPPED' }),
          }),
        ]),
      );
      expect(preview.items.map(({ alias }) => alias)).toEqual(['child', 'root']);
    } finally {
      database.close();
    }
  });

  it('never exposes absolute, home-relative or Windows Include paths in preview metadata', async () => {
    const { database, service } = await fixture(`
Include /Users/alice/.ssh/private/*.conf ~/.ssh/also/*.cfg C:\\Users\\alice\\.ssh\\secret\\*.inc
Host safe
  HostName safe.example.test
  User operator
`);
    try {
      const preview = await service.preview({ grantId: 'ssh-config-grant' });
      expect(preview.includes.map(({ pattern }) => pattern)).toEqual(['*.conf', '*.cfg', '*.inc']);
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain('/Users/alice');
      expect(serialized).not.toContain('~/.ssh');
      expect(serialized).not.toContain('C:\\Users');
      expect(serialized).not.toContain('private');
      expect(serialized).not.toContain('secret');
    } finally {
      database.close();
    }
  });
});

function basenameForTest(path: string): string {
  return path.split('/').pop()!;
}

describe('parseSshConfig', () => {
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
