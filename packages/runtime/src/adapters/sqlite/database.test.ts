import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_THEME_ID } from '@workspace/contracts';
import { ProductRepository, etagFor } from './product-repository';
import { DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT, MigrationError, ProductDatabase } from './database';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-db-'));
  directories.push(directory);
  return {
    database: join(directory, 'product.sqlite'),
    backup: join(directory, 'backup.sqlite'),
    corrupt: join(directory, 'corrupt.sqlite'),
  };
}

describe('Runtime product database', () => {
  it('bounds replayable domain events while preserving monotonic cursors', async () => {
    const database = await ProductDatabase.open();
    try {
      for (let index = 0; index < DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT + 5; index += 1) {
        database.appendEvent('retention.tested', String(index), { index });
      }

      const repository = new ProductRepository(database);
      expect(repository.eventBounds()).toEqual({
        earliest: 6,
        latest: DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT + 5,
      });
      expect(
        database.get<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events')?.count,
      ).toBe(DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT);
      expect(repository.listEvents(5, 1)[0]).toMatchObject({
        cursor: 6,
        aggregateId: '5',
        payload: { index: 5 },
      });
    } finally {
      database.close();
    }
  });

  it('records durable application-version transitions without treating restarts as upgrades', async () => {
    const files = await paths();
    let database = await ProductDatabase.open(files.database);
    expect(database.recordAppVersion('0.9.0', '2026-09-12T00:00:00.000Z')).toEqual({
      currentVersion: '0.9.0',
      previousVersion: null,
      upgraded: false,
      startedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(database.recordAppVersion('0.10.0', '2026-09-13T00:00:00.000Z')).toEqual({
      currentVersion: '0.10.0',
      previousVersion: '0.9.0',
      upgraded: true,
      startedAt: '2026-09-13T00:00:00.000Z',
    });
    database.close();

    database = await ProductDatabase.open(files.database);
    expect(database.recordAppVersion('0.10.0', '2026-09-13T01:00:00.000Z')).toEqual({
      currentVersion: '0.10.0',
      previousVersion: '0.9.0',
      upgraded: false,
      startedAt: '2026-09-13T01:00:00.000Z',
    });
    expect(() => database.recordAppVersion('bad\nversion')).toThrow(
      'Application version is invalid',
    );
    database.close();
  });

  it('migrates existing installs to a fresh local-terminal startup policy', async () => {
    const files = await paths();
    let database = await ProductDatabase.open(files.database);
    let repository = new ProductRepository(database);
    const startupBookmarkId = randomUUID();
    repository.updateSettings(
      {
        workspace: {
          restoreLayout: true,
          startupSessions: [startupBookmarkId],
          showTabNumber: false,
        },
      },
      etagFor(repository.getSettings().version),
    );
    database.run("DELETE FROM app_meta WHERE key = 'migration:33'");
    database.close();

    database = await ProductDatabase.open(files.database);
    repository = new ProductRepository(database);
    const settings = repository.getSettings();
    expect(settings.workspace.restoreLayout).toBe(false);
    expect(settings.workspace.startupSessions).toEqual([]);
    expect(settings.workspace.showTabNumber).toBe(false);
    await expect(access(`${files.database}.pre-migration-33.bak`)).resolves.toBeUndefined();
    database.close();
  });

  it('commits nested repository transactions with their outer unit and rolls all of them back', async () => {
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    try {
      expect(() =>
        database.transaction(() => {
          repository.createHostGroup({ name: 'Rolled back outer', sortOrder: 0 });
          database.transaction(() => {
            repository.createHostGroup({ name: 'Rolled back nested', sortOrder: 1 });
          });
          throw new Error('force outer rollback');
        }),
      ).toThrow('force outer rollback');
      expect(repository.listHostGroups()).toEqual([]);
      expect(repository.listEvents()).toEqual([]);

      database.transaction(() => {
        repository.createHostGroup({ name: 'Committed outer', sortOrder: 0 });
        database.transaction(() => {
          repository.createHostGroup({ name: 'Committed nested', sortOrder: 1 });
        });
      });
      expect(repository.listHostGroups().map(({ name }) => name)).toEqual([
        'Committed outer',
        'Committed nested',
      ]);
      expect(repository.listEvents().map(({ type }) => type)).toEqual([
        'host-group.created',
        'host-group.created',
      ]);
    } finally {
      database.close();
    }
  });

  it('persists host/group/settings, records events and rejects stale writes', async () => {
    const files = await paths();
    let database = await ProductDatabase.open(files.database);
    let repository = new ProductRepository(database);
    const group = repository.createHostGroup({ name: 'Production', sortOrder: 1 });
    const host = repository.createHost({
      groupId: group.id,
      name: 'web-01',
      hostname: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authType: 'privateKey',
      credentialRef: `cred_${randomUUID()}`,
      passphraseCredentialRef: `cred_${randomUUID()}`,
      jumpHostId: null,
      favorite: true,
    });
    const terminalId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    const settings = repository.updateSettings(
      {
        appearance: { theme: 'light', language: 'ja' },
        workspace: {
          showTabNumber: false,
          switchTabOnHover: true,
          activityRailItems: ['widgets', 'bookmarks', 'terminalThemes'],
          activeWorkspaceId: workspaceId,
          startupSessions: workspaceId,
          namedWorkspaces: [
            {
              id: workspaceId,
              name: 'Operations',
              createdAt: now,
              updatedAt: now,
              layout: {
                section: 'hosts',
                sidebarOpen: true,
                split: true,
                tabs: [
                  {
                    id: terminalId,
                    title: 'web-01',
                    kind: 'ssh',
                    connectionId: randomUUID(),
                    pinned: true,
                    paneIndex: 0,
                  },
                ],
                activeTerminalId: terminalId,
                secondaryTerminalId: null,
                layoutMode: 'c2x2',
                paneTerminalIds: [terminalId, null, null, null],
                focusedPane: 0,
              },
            },
          ],
        },
        terminal: {
          defaultProfileId: terminalId,
          screenReaderMode: true,
          autoReconnectTerminal: true,
          restoreTerminalSessionOnReload: true,
          commandSuggestionsEnabled: true,
          dragDropBehavior: 'upload',
          shortcutBarEnabled: false,
          visual: {
            themeId: DEFAULT_TERMINAL_THEME_ID,
            background: {
              kind: 'text',
              assetId: null,
              text: 'Operations',
              textSize: 64,
              textColor: '#abcdef',
              textFontFamily: 'Maple Mono',
              opacity: 0.35,
              blur: 1,
              brightness: 0.8,
              grayscale: 0.2,
              contrast: 1.1,
            },
          },
          shortcutBarButtons: [
            { id: 'custom-test', label: 'Alt+↑', data: '\u001b\u001b[A', custom: true },
          ],
        },
        fileManager: {
          externalEditor: '/usr/bin/vi',
          refreshOnFocus: true,
          followTerminalCwd: true,
          sshSplitView: true,
        },
        monitor: {
          terminalInformationItems: ['sysinfo', 'cpu', 'users'],
          remoteMonitorBarEnabled: true,
          remoteMonitorBarItems: ['memory', 'hostname'],
        },
      },
      etagFor(repository.getSettings().version),
    );
    expect(() => repository.updateHost(host.id, { name: 'stale' }, etagFor(99))).toThrowError(
      expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
    );
    expect(repository.listEvents().map((event) => event.type)).toEqual([
      'host-group.created',
      'host.created',
      'settings.updated',
    ]);
    database.close();

    database = await ProductDatabase.open(files.database);
    repository = new ProductRepository(database);
    expect(repository.listHostGroups()).toEqual([group]);
    expect(repository.getHost(host.id)).toEqual(host);
    expect(repository.getSettings()).toEqual(settings);
    expect(repository.getSettings().workspace.activityRailItems).toEqual([
      'widgets',
      'bookmarks',
      'terminalThemes',
    ]);
    expect(repository.getSettings().workspace.startupSessions).toBe(workspaceId);
    expect(repository.getSettings().terminal).toEqual({
      defaultProfileId: terminalId,
      screenReaderMode: true,
      autoReconnectTerminal: true,
      restoreTerminalSessionOnReload: true,
      commandSuggestionsEnabled: true,
      dragDropBehavior: 'upload',
      shortcutBarEnabled: false,
      visual: {
        themeId: DEFAULT_TERMINAL_THEME_ID,
        background: {
          kind: 'text',
          assetId: null,
          text: 'Operations',
          textSize: 64,
          textColor: '#abcdef',
          textFontFamily: 'Maple Mono',
          opacity: 0.35,
          blur: 1,
          brightness: 0.8,
          grayscale: 0.2,
          contrast: 1.1,
        },
      },
      shortcutBarButtons: [
        { id: 'custom-test', label: 'Alt+↑', data: '\u001b\u001b[A', custom: true },
      ],
    });
    expect(repository.getSettings().monitor).toEqual({
      terminalInformationItems: ['sysinfo', 'cpu', 'users'],
      remoteMonitorBarEnabled: true,
      remoteMonitorBarItems: ['memory', 'hostname'],
    });
    expect(repository.getSettings().fileManager).toMatchObject({
      externalEditor: '/usr/bin/vi',
      refreshOnFocus: true,
      followTerminalCwd: true,
      sshSplitView: true,
    });
    const bytes = await readFile(files.database);
    expect(bytes.toString('utf8')).not.toContain('PRIVATE KEY');
    database.close();
  });

  it('creates a validated backup and restores it while preserving the replaced database', async () => {
    const files = await paths();
    let database = await ProductDatabase.open(files.database);
    const repository = new ProductRepository(database);
    repository.createHostGroup({ name: 'Before backup', sortOrder: 0 });
    await database.backup(files.backup);
    repository.createHostGroup({ name: 'After backup', sortOrder: 1 });
    database.close();

    const preserved = await ProductDatabase.restore(files.backup, files.database);
    expect((await readFile(preserved)).length).toBeGreaterThan(0);
    database = await ProductDatabase.open(files.database);
    expect(new ProductRepository(database).listHostGroups().map((item) => item.name)).toEqual([
      'Before backup',
    ]);
    database.close();
  });

  it('rejects corrupt input and a migration checksum mismatch without replacing the database', async () => {
    const files = await paths();
    await writeFile(files.corrupt, 'not sqlite');
    await expect(ProductDatabase.restore(files.corrupt, files.database)).rejects.toThrow();

    const database = await ProductDatabase.open(files.database);
    database.close();
    const connection = new DatabaseSync(files.database);
    connection.prepare("UPDATE app_meta SET value='changed' WHERE key='migration:1'").run();
    connection.close();
    const before = await readFile(files.database);
    await expect(ProductDatabase.open(files.database)).rejects.toBeInstanceOf(MigrationError);
    expect(await readFile(files.database)).toEqual(before);
  });
});
