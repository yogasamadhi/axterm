import { DesktopRuntimeController } from '../../packages/plugins/desktop/src/index.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_THEME_ID } from '@axterm/plugin-api/terminals';
import { productDomains } from '@axterm/data-schema';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { HostRepository } from '../../packages/plugins/catalog/src/adapters/host-repository.ts';
import { SettingsRepository } from '../../packages/plugins/configuration/src/adapters/settings-repository.ts';
import { Generation2Database } from '../fixtures/migration/generation2-database.ts';
import historicalSettings from '../fixtures/migration/generation2-settings.json';
import { applyHistoricalSql } from '../fixtures/migration/historical-sql.ts';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const etagFor = (version: number) => '"v' + version + '"';
async function paths() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-database-owned-'));
  directories.push(directory);
  return {
    database: join(directory, 'product.sqlite'),
    corrupt: join(directory, 'corrupt.sqlite'),
  };
}
async function boot(path: string) {
  const f = await ownedStorage(path),
    catalog = await f.open(productDomains.catalog),
    configuration = await f.open(productDomains.configuration);
  return {
    ...f,
    catalog,
    configuration,
    hosts: new HostRepository(new CatalogStorage(catalog), () => []),
    settings: new SettingsRepository(configuration),
  };
}
it('persists host/group/settings, records events and rejects stale writes', async () => {
  const files = await paths();
  let facts = await boot(files.database);
  const group = facts.hosts.createHostGroup({ name: 'Production', sortOrder: 1 });
  const host = facts.hosts.createHost({
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
  const settings = facts.settings.updateSettings(
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
    etagFor(facts.settings.getSettings().version),
  );
  expect(() => facts.hosts.updateHost(host.id, { name: 'stale' }, etagFor(99))).toThrowError(
    expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
  );
  expect(facts.catalog.events(0).map((event) => event.type)).toEqual([
    'host-group.created',
    'host.created',
  ]);
  expect(facts.configuration.events(0).map((event) => event.type)).toEqual(['settings.updated']);
  await facts.close();

  facts = await boot(files.database);
  expect(facts.hosts.listHostGroups()).toEqual([group]);
  expect(facts.hosts.getHost(host.id)).toEqual(host);
  expect(facts.settings.getSettings()).toEqual(settings);
  expect(facts.settings.getSettings().workspace.activityRailItems).toEqual([
    'widgets',
    'bookmarks',
    'terminalThemes',
  ]);
  expect(facts.settings.getSettings().workspace.startupSessions).toBe(workspaceId);
  expect(facts.settings.getSettings().terminal).toEqual({
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
  expect(facts.settings.getSettings().monitor).toEqual({
    terminalInformationItems: ['sysinfo', 'cpu', 'users'],
    remoteMonitorBarEnabled: true,
    remoteMonitorBarItems: ['memory', 'hostname'],
  });
  expect(facts.settings.getSettings().fileManager).toMatchObject({
    externalEditor: '/usr/bin/vi',
    refreshOnFocus: true,
    followTerminalCwd: true,
    sshSplitView: true,
  });
  const bytes = await readFile(files.database);
  expect(bytes.toString('utf8')).not.toContain('PRIVATE KEY');
  await facts.close();
});

it('preserves nested Host fact transactions and outbox with their outer commit or rollback', async () => {
  const f = await boot(':memory:');
  expect(() =>
    f.catalog.transaction(() => {
      f.hosts.createHostGroup({ name: 'Rolled back outer', sortOrder: 0 });
      f.catalog.transaction(() =>
        f.hosts.createHostGroup({ name: 'Rolled back nested', sortOrder: 1 }),
      );
      throw Error('force outer rollback');
    }),
  ).toThrow('force outer rollback');
  expect(f.hosts.listHostGroups()).toEqual([]);
  expect(f.catalog.events(0)).toEqual([]);
  f.catalog.transaction(() => {
    f.hosts.createHostGroup({ name: 'Committed outer', sortOrder: 0 });
    f.catalog.transaction(() =>
      f.hosts.createHostGroup({ name: 'Committed nested', sortOrder: 1 }),
    );
  });
  expect(f.hosts.listHostGroups().map(({ name }) => name)).toEqual([
    'Committed outer',
    'Committed nested',
  ]);
  expect(f.catalog.events(0).map(({ type }) => type)).toEqual([
    'host-group.created',
    'host-group.created',
  ]);
});
it('retains original startup SQL33 while preserving independent workspace preferences', async () => {
  const files = await paths(),
    input = await Generation2Database.open(files.database);
  input.run(
    "INSERT INTO app_settings(section,payload,version,updated_at) VALUES('workspace',?,1,?) ON CONFLICT(section) DO UPDATE SET payload=excluded.payload",
    JSON.stringify({
      ...historicalSettings.initial.workspace,
      restoreLayout: true,
      startupSessions: [randomUUID()],
      showTabNumber: false,
    }),
    new Date().toISOString(),
  );
  input.close();
  const witness = new DatabaseSync(files.database);
  try {
    applyHistoricalSql(witness, 33);
  } finally {
    witness.close();
  }
  const f = await boot(files.database),
    actual = f.settings.getSettings();
  expect(actual.workspace.restoreLayout).toBe(false);
  expect(actual.workspace.startupSessions).toEqual([]);
  expect(actual.workspace.showTabNumber).toBe(false);
});
it('creates only current import bookkeeping and keeps the clean generation marker', async () => {
  const files = await paths(),
    f = await boot(files.database);
  await f.close();
  const probe = new DatabaseSync(files.database, { readOnly: true });
  try {
    expect(
      probe.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%import_entries%'").get(),
    ).toEqual({ name: 'axterm_configuration_import_entries' });
    expect(
      probe.prepare("SELECT value FROM app_meta WHERE key='axterm:schema-generation'").get(),
    ).toEqual({ value: '2' });
  } finally {
    probe.close();
  }
});
it('rejects earlier profiles, corrupt input and immutable checksum changes without modifying original bytes', async () => {
  const early = await paths(),
    input = new DatabaseSync(early.database);
  input.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  input.close();
  const before = await readFile(early.database);
  await expect(ownedStorage(early.database)).rejects.toThrow();
  expect(await readFile(early.database)).toEqual(before);
  const corrupt = await paths();
  await writeFile(corrupt.database, 'not sqlite');
  const corruptBefore = await readFile(corrupt.database);
  await expect(ownedStorage(corrupt.database)).rejects.toThrow();
  expect(await readFile(corrupt.database)).toEqual(corruptBefore);
  const changed = await paths(),
    current = await boot(changed.database);
  await current.close();
  const tamper = new DatabaseSync(changed.database);
  tamper.prepare("UPDATE app_meta SET value='changed' WHERE key='migration:1'").run();
  tamper.close();
  const bytes = await readFile(changed.database);
  await expect(ownedStorage(changed.database)).rejects.toThrow();
  expect(await readFile(changed.database)).toEqual(bytes);
});

it('uses current immutable launch identity while preserving historical application-version rows across restarts', async () => {
  const files = await paths(),
    input = await Generation2Database.open(files.database);
  const historical = [
    ['app:current-version', '0.10.0'],
    ['app:previous-version', '0.9.0'],
    ['app:last-started-at', '2026-09-13T01:00:00.000Z'],
  ];
  for (const [key, value] of historical)
    input.run('INSERT INTO app_meta(key,value) VALUES(?,?)', key!, value!);
  input.close();
  const generations = new Set<string>();
  for (const [version, startedAt] of [
    ['0.9.0', '2026-09-12T00:00:00.000Z'],
    ['0.10.0', '2026-09-13T00:00:00.000Z'],
    ['0.10.0', '2026-09-13T01:00:00.000Z'],
  ]) {
    const f = await ownedStorage(files.database),
      generation = randomUUID();
    f.ctx.provide('runtimeIdentity', {
      generation,
      runtimeId: randomUUID(),
      startedAt: startedAt!,
      pid: process.pid,
      mode: 'headless',
      appVersion: version!,
    });
    const controller = new DesktopRuntimeController(f.ctx);
    expect(controller.getVersion()).toEqual({ apiVersion: 'v1', appVersion: version });
    expect(controller.getRuntimeMetadata()).toMatchObject({
      generation,
      startedAt,
      state: 'ready',
    });
    generations.add(generation);
    await f.close();
    const probe = new DatabaseSync(files.database, { readOnly: true });
    try {
      expect(
        probe.prepare("SELECT key,value FROM app_meta WHERE key LIKE 'app:%' ORDER BY key").all(),
      ).toEqual(
        historical
          .map(([key, value]) => ({ key, value }))
          .sort((a, b) => a.key!.localeCompare(b.key!)),
      );
    } finally {
      probe.close();
    }
  }
  expect(generations.size).toBe(3);
});
