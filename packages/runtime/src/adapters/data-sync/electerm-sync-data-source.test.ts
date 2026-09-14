import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { HostCapabilityClient } from '../host-capability/client';
import { BookmarkRepository } from '../sqlite/bookmark-repository';
import { ConnectionProfileRepository } from '../sqlite/connection-profile-repository';
import { ProductDatabase } from '../sqlite/database';
import { etagFor, ProductRepository } from '../sqlite/product-repository';
import { QuickCommandRepository } from '../sqlite/quick-command-repository';
import { TerminalThemeRepository } from '../sqlite/terminal-theme-repository';
import { TriggerRepository } from '../sqlite/trigger-repository';
import { BookmarkTreeService } from '../../application/bookmark-tree-service';
import { ConnectionProfileService } from '../../application/connection-profile-service';
import { ElectermDataService } from '../../application/electerm-data-service';
import { QuickCommandService } from '../../application/quick-command-service';
import { RealtimeHub } from '../../application/realtime-hub';
import { SshBookmarkService } from '../../application/ssh-bookmark-service';
import {
  DARK_TERMINAL_THEME_ID,
  TerminalThemeService,
} from '../../application/terminal-theme-service';
import { TerminalService } from '../../application/terminal-service';
import { TriggerService } from '../../application/trigger-service';
import type { SyncCategory } from '@workspace/contracts';
import { ElectermSyncDataSource } from './electerm-sync-data-source';

const databases: ProductDatabase[] = [];
type Fixture = ReturnType<typeof buildFixture>;
const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.source.close();
    fixture.triggers.close();
    await fixture.terminals.closeAll();
    fixture.realtime.close();
  }
  for (const database of databases.splice(0)) database.close();
});

async function createFixture(): Promise<Fixture> {
  const database = await ProductDatabase.open();
  databases.push(database);
  const fixture = buildFixture(database);
  fixtures.push(fixture);
  return fixture;
}

function buildFixture(database: ProductDatabase) {
  const products = new ProductRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const profiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
  const quickCommands = new QuickCommandService(new QuickCommandRepository(database));
  const sshBookmarks = new SshBookmarkService(database, products, bookmarks);
  const terminals = new TerminalService({
    open() {
      throw new Error('PTY is unavailable in sync data tests');
    },
  });
  const realtime = new RealtimeHub();
  const triggers = new TriggerService(
    new TriggerRepository(database),
    terminals,
    realtime,
    bookmarks,
  );
  let windowPreferences = {
    titleBarStyle: 'custom' as const,
    opacity: 1,
    zoomFactor: 1,
    bounds: null,
    globalHotkey: '',
    allowMultiInstance: false,
    confirmBeforeExit: false,
  };
  const host = {
    async listCredentials() {
      return [];
    },
    async windowPreferences() {
      return {
        preferences: structuredClone(windowPreferences),
        requiresRestart: false,
        globalHotkeyRegistered: false,
      };
    },
    async updateWindowPreferences(patch: Partial<typeof windowPreferences>) {
      windowPreferences = { ...windowPreferences, ...patch };
      return {
        preferences: structuredClone(windowPreferences),
        requiresRestart: false,
        globalHotkeyRegistered: false,
      };
    },
    async createCredential() {
      throw new Error('Portable sync must not create secrets in this fixture');
    },
    async deleteCredential() {},
  } as unknown as HostCapabilityClient;
  const electermData = new ElectermDataService(
    database,
    products,
    bookmarks,
    sshBookmarks,
    profiles,
    quickCommands,
    host,
  );
  const terminalThemes = new TerminalThemeService(new TerminalThemeRepository(products), undefined);
  const source = new ElectermSyncDataSource(
    electermData,
    products,
    terminalThemes,
    quickCommands,
    triggers,
    '0.10.0-test',
    'sync-fixture',
  );
  return {
    database,
    products,
    bookmarks,
    profiles,
    quickCommands,
    terminals,
    realtime,
    triggers,
    terminalThemes,
    electermData,
    source,
  };
}

const allCategories: SyncCategory[] = [
  'settings',
  'bookmarks',
  'terminalThemes',
  'quickCommands',
  'profiles',
  'addressBookmarks',
  'workspaces',
  'triggers',
];

describe('ElectermSyncDataSource', () => {
  it('snapshots and explicitly commits all eight selected categories', async () => {
    const first = await createFixture();
    const second = await createFixture();

    const imported = await first.electermData.previewPortableDocument(
      {
        profiles: [{ id: 'profile-ops', name: 'Operations', username: 'deploy' }],
        bookmarks: [
          {
            id: 'bookmark-ops',
            type: 'ssh',
            title: 'Operations host',
            host: 'ops.example.test',
            username: 'deploy',
            authType: 'profiles',
            profile: 'profile-ops',
          },
        ],
        bookmarkGroups: [
          {
            id: 'default',
            title: 'default',
            bookmarkIds: ['bookmark-ops'],
            bookmarkGroupIds: [],
          },
        ],
      },
      'seed.json',
    );
    await first.electermData.commit(imported.previewId, imported.treeEtag);

    let commands = first.quickCommands.snapshot();
    commands = first.quickCommands.createGroup(
      { parentId: null, name: 'Operations' },
      commands.etag,
    );
    first.quickCommands.createCommand(
      {
        groupId: commands.groups[0]!.id,
        name: 'Uptime',
        command: 'uptime',
        commands: [{ id: randomUUID(), name: 'Run uptime', command: 'uptime', delayMs: 100 }],
        description: 'Show uptime',
        tags: ['ops'],
        shortcut: null,
        inputOnly: true,
        clickCount: 2,
      },
      commands.etag,
    );
    first.terminalThemes.clone(DARK_TERMINAL_THEME_ID, 'Synced night');
    const triggerCollection = first.triggers.snapshot();
    first.triggers.create(
      {
        name: 'Ready notification',
        enabled: true,
        match: { type: 'text', value: 'ready', caseSensitive: false },
        action: { type: 'notify', value: '' },
        sendEnter: false,
        mode: 'once',
        cooldownMs: 0,
      },
      triggerCollection.etag,
    );
    const workspaceId = randomUUID();
    const timestamp = '2026-09-20T12:00:00.000Z';
    first.products.updateSettings(
      {
        appearance: { theme: 'light' },
        workspace: {
          namedWorkspaces: [
            {
              id: workspaceId,
              name: 'Synced workspace',
              createdAt: timestamp,
              updatedAt: timestamp,
              layout: {
                section: 'hosts',
                contentSurface: 'terminal',
                sidebarOpen: true,
                split: false,
                tabs: [],
                activeTerminalId: null,
                secondaryTerminalId: null,
                layoutMode: 'c1',
                paneTerminalIds: [null],
                focusedPane: 0,
              },
            },
          ],
          activeWorkspaceId: workspaceId,
        },
        fileManager: {
          remoteAddressBookmarks: [{ id: randomUUID(), hostId: null, path: '/srv/应用' }],
        },
      },
      etagFor(first.products.getSettings().version),
    );

    const document = await first.source.snapshot(allCategories);
    for (const category of allCategories)
      expect(document.categories[category]?.count).toBeGreaterThan(0);

    const preview = await second.source.preview(document, allCategories);
    expect(preview.entries.map(({ sourceId }) => sourceId)).toEqual(
      expect.arrayContaining(['terminalThemes', 'quickCommands', 'triggers']),
    );
    await second.source.commit(preview.previewId, preview.treeEtag);

    const received = await second.source.snapshot(allCategories);
    for (const category of [
      'settings',
      'terminalThemes',
      'quickCommands',
      'addressBookmarks',
      'workspaces',
      'triggers',
    ] as const)
      expect(received.categories[category]?.hash).toBe(document.categories[category]?.hash);
    expect(received.categories.bookmarks?.count).toBeGreaterThan(0);
    expect(received.categories.profiles?.count).toBeGreaterThan(0);
    expect(second.quickCommands.snapshot()).toMatchObject({
      groups: [expect.objectContaining({ name: 'Operations' })],
      commands: [expect.objectContaining({ name: 'Uptime', clickCount: 2 })],
    });
    expect(second.terminalThemes.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Synced night' })]),
    );
    expect(second.triggers.snapshot().triggers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Ready notification' })]),
    );
  });
});
