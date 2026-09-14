import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import { QuickCommandRepository } from '../adapters/sqlite/quick-command-repository';
import { BookmarkTreeService } from './bookmark-tree-service';
import { ConnectionProfileService } from './connection-profile-service';
import { ElectermDataService } from './electerm-data-service';
import { SshBookmarkService } from './ssh-bookmark-service';
import { QuickCommandService } from './quick-command-service';

const directories: string[] = [];
const databases: ProductDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(source: object) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-electerm-data-'));
  directories.push(directory);
  const importPath = join(directory, 'electerm-data.json');
  const exportPath = join(directory, 'axterm-export.json');
  await writeFile(importPath, JSON.stringify(source), 'utf8');
  const database = await ProductDatabase.open();
  databases.push(database);
  const repository = new ProductRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const sshBookmarks = new SshBookmarkService(database, repository, bookmarks);
  const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const quickCommands = new QuickCommandService(new QuickCommandRepository(database));
  const credentials = new Map<string, { kind: string; label: string; secret: string }>();
  const deleted: string[] = [];
  let sequence = 0;
  const timestamp = '2026-09-12T00:00:00.000Z';
  let desktopPreferences = {
    titleBarStyle: 'custom' as const,
    opacity: 1,
    zoomFactor: 1,
    bounds: null,
    globalHotkey: 'Control+2',
    allowMultiInstance: false,
    confirmBeforeExit: false,
  };
  const capability = {
    async resolveGrant(grantId: string) {
      return grantId === 'export-grant'
        ? {
            grantId,
            kind: 'save-target' as const,
            name: 'axterm-export.json',
            permissions: ['write' as const],
            createdAt: timestamp,
            path: exportPath,
          }
        : {
            grantId,
            kind: 'file' as const,
            name: 'electerm-data.json',
            permissions: ['read' as const],
            createdAt: timestamp,
            path: importPath,
          };
    },
    async createCredential(input: { kind: string; label: string; secret: string }) {
      const ref = `local-credential-${++sequence}`;
      credentials.set(ref, input);
      return {
        ref,
        kind: input.kind,
        label: input.label,
        createdAt: timestamp,
        updatedAt: timestamp,
        storage: 'local' as const,
      };
    },
    async deleteCredential(ref: string) {
      deleted.push(ref);
      credentials.delete(ref);
    },
    async listCredentials() {
      return [...credentials].map(([ref, credential]) => ({
        ref,
        kind: credential.kind,
        label: credential.label,
        createdAt: timestamp,
        updatedAt: timestamp,
        storage: 'local' as const,
      }));
    },
    async windowPreferences() {
      return {
        preferences: structuredClone(desktopPreferences),
        requiresRestart: false,
        globalHotkeyRegistered: true,
      };
    },
    async updateWindowPreferences(patch: Partial<typeof desktopPreferences>) {
      desktopPreferences = { ...desktopPreferences, ...patch };
      return {
        preferences: structuredClone(desktopPreferences),
        requiresRestart: false,
        globalHotkeyRegistered: true,
      };
    },
  } satisfies Pick<
    HostCapabilityClient,
    | 'resolveGrant'
    | 'createCredential'
    | 'deleteCredential'
    | 'listCredentials'
    | 'windowPreferences'
    | 'updateWindowPreferences'
  >;
  const service = new ElectermDataService(
    database,
    repository,
    bookmarks,
    sshBookmarks,
    profiles,
    quickCommands,
    capability as HostCapabilityClient,
  );
  return {
    directory,
    importPath,
    exportPath,
    database,
    repository,
    bookmarks,
    profiles,
    credentials,
    deleted,
    getDesktopPreferences: () => structuredClone(desktopPreferences),
    service,
  };
}

const electermFixture = {
  bookmarks: [
    {
      id: 'bookmark-profile',
      type: 'ssh',
      title: 'Production shell',
      host: 'prod.example.test',
      port: 2222,
      username: 'fallback-user',
      authType: 'profiles',
      profile: 'profile-production',
      password: 'stale-bookmark-password',
      description: 'Imported from Electerm',
      quickCommands: [{ name: 'Bookmark uptime', command: 'uptime' }],
      triggers: [
        {
          id: 'legacy-id',
          name: 'Pager response',
          enabled: true,
          match: { type: 'text', value: '--More--', caseSensitive: true },
          action: { type: 'send', value: ' ' },
          sendEnter: false,
          mode: 'cooldown',
          cooldownMs: 500,
        },
      ],
    },
    {
      id: 'bookmark-password',
      type: 'ssh',
      title: 'Root shell',
      host: 'root.example.test',
      username: 'operator',
      authType: 'password',
      password: 'root-password-secret',
    },
    {
      id: 'bookmark-telnet',
      type: 'telnet',
      title: 'Legacy switch',
      host: 'switch.example.test',
      password: 'telnet-bookmark-secret',
    },
  ],
  bookmarkGroups: [
    {
      id: 'default',
      title: 'default',
      bookmarkIds: ['bookmark-password'],
      bookmarkGroupIds: ['group-production'],
    },
    {
      id: 'group-production',
      title: 'Production',
      bookmarkIds: [],
      bookmarkGroupIds: ['group-services'],
    },
    {
      id: 'group-services',
      title: 'Services',
      bookmarkIds: ['bookmark-profile', 'bookmark-telnet'],
      bookmarkGroupIds: [],
    },
  ],
  profiles: [
    {
      id: 'profile-production',
      name: 'Production identity',
      isDefault: true,
      username: 'deploy',
      password: 'profile-password-secret',
      privateKey: '/Users/example/.ssh/id_ed25519',
      passphrase: 'unused-path-passphrase',
      telnet: { username: 'legacy', password: 'profile-telnet-secret' },
    },
  ],
  quickCommands: [
    {
      id: 'command-uptime',
      name: 'System uptime',
      command: 'uptime',
      description: 'Show uptime',
      tags: ['system'],
    },
  ],
  terminalThemes: [{ id: 'theme-one', name: 'Theme one' }],
  config: {
    language: 'zh_cn',
    theme: 'dark',
    onStartSessions: ['bookmark-profile', 'bookmark-telnet', 'missing-bookmark'],
    leftSideBarIcons: ['widgets', 'bookmarks', 'quickConnect'],
    defaultEditor: '/usr/bin/vi',
    screenReaderMode: true,
    autoRefreshWhenSwitchToSftp: true,
    sftpPathFollowSsh: true,
    sshSftpSplitView: true,
  },
};

describe('ElectermDataService', () => {
  it('previews and transactionally imports supported Electerm hierarchy without plaintext DB data', async () => {
    const context = await fixture(electermFixture);
    const preview = await context.service.preview('import-grant');

    expect(preview.counts).toEqual({
      create: 7,
      unchanged: 0,
      skip: 2,
      groups: 2,
      profiles: 1,
      sshBookmarks: 2,
      quickCommands: 1,
      settings: 1,
      credentialMetadata: 0,
    });
    expect(JSON.stringify(preview)).not.toContain('profile-password-secret');
    expect(preview.entries.find(({ sourceId }) => sourceId === 'bookmark-telnet')).toMatchObject({
      kind: 'bookmark',
      action: 'skip',
    });
    expect(preview.entries.find(({ sourceId }) => sourceId === 'profile-production')).toMatchObject(
      {
        omittedFields: ['privateKey', 'passphrase'],
      },
    );

    const result = await context.service.commit(preview.previewId, preview.treeEtag);
    expect(result.counts.create).toBe(7);
    const production = result.tree.groups.find(({ name }) => name === 'Production')!;
    const services = result.tree.groups.find(({ name }) => name === 'Services')!;
    expect(services.parentId).toBe(production.id);
    const importedProfile = context.profiles.list()[0]!;
    expect(importedProfile).toMatchObject({
      name: 'Production identity',
      ssh: { username: 'deploy', privateKeyCredentialRef: null },
      telnet: { username: 'legacy' },
    });
    const profileBookmark = result.tree.bookmarks.find(
      ({ title }) => title === 'Production shell',
    )!;
    expect(profileBookmark).toMatchObject({
      groupId: services.id,
      connectionProfileId: importedProfile.id,
      quickCommands: [{ name: 'Bookmark uptime', command: 'uptime' }],
      triggers: [
        expect.objectContaining({
          name: 'Pager response',
          match: { type: 'text', value: '--More--', caseSensitive: true },
          action: { type: 'send', value: ' ' },
        }),
      ],
    });
    const profileHost = context.repository.getHost(profileBookmark.hostId!);
    expect(profileHost).toMatchObject({ authType: 'agent', credentialRef: null });
    expect([...context.credentials.values()].map(({ secret }) => secret).sort()).toEqual(
      ['profile-password-secret', 'profile-telnet-secret', 'root-password-secret'].sort(),
    );

    const stored = context.database
      .all<{ payload?: string; credential_ref?: string }>(
        `SELECT payload FROM connection_profiles
         UNION ALL SELECT credential_ref AS payload FROM hosts`,
      )
      .map(({ payload }) => payload ?? '')
      .join('\n');
    for (const secret of [
      'profile-password-secret',
      'profile-telnet-secret',
      'root-password-secret',
      'stale-bookmark-password',
    ])
      expect(stored).not.toContain(secret);

    const repeated = await context.service.preview('import-grant');
    expect(repeated.counts).toMatchObject({ create: 0, unchanged: 7, skip: 2 });
    expect(context.repository.listJson('quick_commands')).toHaveLength(1);
    expect(context.repository.getSettings().workspace.activityRailItems).toEqual([
      'widgets',
      'bookmarks',
      'quickConnect',
    ]);
    expect(context.repository.getSettings()).toMatchObject({
      workspace: { startupSessions: [profileBookmark.id] },
      terminal: { screenReaderMode: true },
      fileManager: {
        externalEditor: '/usr/bin/vi',
        refreshOnFocus: true,
        followTerminalCwd: true,
        sshSplitView: true,
      },
    });
  });

  it('exports Electerm-compatible data atomically while omitting credential values', async () => {
    const context = await fixture(electermFixture);
    const preview = await context.service.preview('import-grant');
    await context.service.commit(preview.previewId, preview.treeEtag);

    const result = await context.service.export('export-grant');
    const raw = await readFile(context.exportPath, 'utf8');
    const exported = JSON.parse(raw) as Record<string, unknown>;
    expect(result).toMatchObject({ groups: 2, profiles: 1, sshBookmarks: 2, quickCommands: 1 });
    expect(exported).toEqual(
      expect.objectContaining({
        bookmarks: expect.any(Array),
        bookmarkGroups: expect.any(Array),
        profiles: expect.any(Array),
        quickCommands: expect.any(Array),
        config: expect.any(Object),
        _axterm: expect.objectContaining({
          formatVersion: 2,
          credentials: 'omitted',
          settings: expect.any(Object),
          desktopPreferences: expect.any(Object),
          credentialMetadata: expect.any(Array),
        }),
      }),
    );
    expect(result).toMatchObject({ settingsIncluded: true, credentialMetadataCount: 3 });
    expect(raw).not.toContain('profile-password-secret');
    expect(raw).not.toContain('profile-telnet-secret');
    expect(raw).not.toContain('root-password-secret');
    expect(raw).not.toContain('local-credential-');
    expect((exported.bookmarkGroups as Array<{ id: string }>)[0]?.id).toBe('default');
    expect((exported.config as { leftSideBarIcons?: string[] }).leftSideBarIcons).toEqual([
      'widgets',
      'bookmarks',
      'quickConnect',
    ]);
    expect(
      (
        exported.bookmarks as Array<{
          title: string;
          authType: string;
          quickCommands: Array<{ name: string; command: string }>;
          triggers: Array<{ name: string; action: { type: string; value: string } }>;
        }>
      ).find(({ title }) => title === 'Production shell'),
    ).toMatchObject({
      authType: 'profiles',
      quickCommands: [{ name: 'Bookmark uptime', command: 'uptime' }],
      triggers: [
        expect.objectContaining({ name: 'Pager response', action: { type: 'send', value: ' ' } }),
      ],
    });
  });

  it('round-trips portable settings and reports credential metadata without creating secrets', async () => {
    const context = await fixture({
      _axterm: {
        formatVersion: 2,
        settings: {
          appearance: { theme: 'light', language: 'en' },
          workspace: {
            switchTabOnHover: true,
            showTabNumber: false,
            activityRailItems: ['widgets', 'quickConnect', 'bookmarks'],
          },
          privacy: { hideAddresses: true },
          terminal: {
            autoReconnectTerminal: true,
            dragDropBehavior: 'upload',
            shortcutBarEnabled: false,
          },
          fileManager: { showHiddenFiles: false },
          monitor: { remoteMonitorBarEnabled: true },
        },
        desktopPreferences: {
          titleBarStyle: 'system',
          opacity: 0.82,
          zoomFactor: 1.2,
          globalHotkey: 'Alt+Shift+F10',
          allowMultiInstance: true,
          confirmBeforeExit: true,
          bounds: { x: 10, y: 10, width: 800, height: 600 },
        },
        credentialMetadata: [
          {
            kind: 'sshPassword',
            label: 'Production password',
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-09-12T00:00:00.000Z',
          },
          {
            kind: 'aiApiKey',
            label: 'Local model key',
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-09-12T00:00:00.000Z',
          },
        ],
      },
    });

    const preview = await context.service.preview('import-grant');
    expect(preview.counts).toMatchObject({
      create: 1,
      unchanged: 0,
      skip: 1,
      settings: 1,
      credentialMetadata: 2,
    });
    expect(preview.entries.find(({ sourceId }) => sourceId === 'settings')).toMatchObject({
      action: 'create',
      mappedFields: expect.arrayContaining([
        'appearance.theme',
        'terminal.dragDropBehavior',
        'desktop.globalHotkey',
      ]),
      omittedFields: expect.arrayContaining(['desktop.bounds', 'network.proxy']),
    });
    expect(preview.entries.find(({ sourceId }) => sourceId === 'credentialMetadata')).toMatchObject(
      {
        action: 'skip',
        mappedFields: ['kind', 'label', 'createdAt', 'updatedAt'],
      },
    );

    const result = await context.service.commit(preview.previewId, preview.treeEtag);
    expect(result).toMatchObject({
      settingsApplied: true,
      credentialMetadataReported: 2,
      createdCredentialCount: 0,
    });
    expect(context.repository.getSettings()).toMatchObject({
      appearance: { theme: 'light', language: 'en' },
      workspace: {
        switchTabOnHover: true,
        showTabNumber: false,
        activityRailItems: ['widgets', 'quickConnect', 'bookmarks'],
      },
      privacy: { hideAddresses: true },
      terminal: {
        autoReconnectTerminal: true,
        dragDropBehavior: 'upload',
        shortcutBarEnabled: false,
      },
      fileManager: { showHiddenFiles: false },
      monitor: { remoteMonitorBarEnabled: true },
    });
    expect(context.getDesktopPreferences()).toMatchObject({
      titleBarStyle: 'system',
      opacity: 0.82,
      zoomFactor: 1.2,
      globalHotkey: 'Alt+Shift+F10',
      allowMultiInstance: true,
      confirmBeforeExit: true,
      bounds: null,
    });
    expect(context.credentials.size).toBe(0);
  });

  it('restores desktop preferences when the settings version changes after preview', async () => {
    const context = await fixture({
      _axterm: {
        formatVersion: 2,
        settings: { appearance: { theme: 'light' } },
        desktopPreferences: { opacity: 0.75 },
      },
    });
    const preview = await context.service.preview('import-grant');
    const current = context.repository.getSettings();
    context.repository.updateSettings({ appearance: { language: 'en' } }, etagFor(current.version));

    await expect(context.service.commit(preview.previewId, preview.treeEtag)).rejects.toMatchObject(
      {
        code: 'PRECONDITION_FAILED',
        status: 412,
      },
    );
    expect(context.getDesktopPreferences()).toMatchObject({ opacity: 1 });
    expect(context.repository.getSettings()).toMatchObject({
      appearance: { theme: 'dark', language: 'en' },
    });
  });

  it('rejects credential metadata that attempts to carry a secret value', async () => {
    const context = await fixture({
      _axterm: {
        formatVersion: 2,
        credentialMetadata: [
          {
            kind: 'sshPassword',
            label: 'Unsafe record',
            createdAt: '2026-09-12T00:00:00.000Z',
            updatedAt: '2026-09-12T00:00:00.000Z',
            secret: 'must-not-import',
          },
        ],
      },
    });

    await expect(context.service.preview('import-grant')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
    expect(context.credentials.size).toBe(0);
  });

  it('reports changed source identities, group cycles and missing dependencies without overwriting data', async () => {
    const context = await fixture(electermFixture);
    const initial = await context.service.preview('import-grant');
    await context.service.commit(initial.previewId, initial.treeEtag);
    await writeFile(
      context.importPath,
      JSON.stringify({
        bookmarks: [
          {
            id: 'bookmark-profile',
            type: 'ssh',
            title: 'Changed title',
            host: 'changed.example.test',
            authType: 'profiles',
            profile: 'missing-profile',
          },
        ],
        bookmarkGroups: [
          { id: 'group-a', title: 'A', bookmarkGroupIds: ['group-b'] },
          { id: 'group-b', title: 'B', bookmarkGroupIds: ['group-a'] },
        ],
      }),
      'utf8',
    );

    const preview = await context.service.preview('import-grant');
    expect(preview.entries.find(({ sourceId }) => sourceId === 'bookmark-profile')).toMatchObject({
      action: 'skip',
    });
    expect(
      preview.entries
        .filter(({ kind }) => kind === 'group')
        .every(
          ({ action, reasons }) =>
            action === 'skip' && reasons.some((value) => /cycle/u.test(value)),
        ),
    ).toBe(true);
    expect(context.repository.listHosts()).toHaveLength(2);
  });

  it('rolls back every database write and removes newly created credential refs on late failure', async () => {
    const context = await fixture({
      bookmarks: [
        {
          id: 'bookmark-fail',
          type: 'ssh',
          title: 'Fail import',
          host: 'fail.example.test',
          password: 'failure-secret',
        },
      ],
      bookmarkGroups: [{ id: 'default', bookmarkIds: ['bookmark-fail'] }],
      profiles: [
        { id: 'profile-fail', name: 'Will roll back', password: 'profile-failure-secret' },
      ],
    });
    context.database.run(`CREATE TRIGGER fail_electerm_bookmark
      BEFORE INSERT ON bookmarks BEGIN SELECT RAISE(ABORT, 'forced Electerm import failure'); END`);
    const preview = await context.service.preview('import-grant');

    await expect(context.service.commit(preview.previewId, preview.treeEtag)).rejects.toThrow(
      'forced Electerm import failure',
    );
    expect(context.repository.listHosts()).toEqual([]);
    expect(context.profiles.list()).toEqual([]);
    expect(context.bookmarks.snapshot()).toMatchObject({ revision: 1, groups: [], bookmarks: [] });
    expect(context.repository.listJson('quick_commands')).toEqual([]);
    expect(context.credentials.size).toBe(0);
    expect(context.deleted).toHaveLength(2);
    expect(context.database.all('SELECT * FROM electerm_import_entries')).toEqual([]);
  });
});
