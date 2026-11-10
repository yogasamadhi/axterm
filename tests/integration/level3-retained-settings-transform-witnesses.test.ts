import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { productDomains } from '@axterm/data-schema';
import { DEFAULT_TERMINAL_THEME_ID, type TerminalTheme } from '@axterm/plugin-api/terminals';
import { Generation2Database } from '../fixtures/migration/generation2-database.ts';
import { Generation2SettingsWitness } from '../fixtures/migration/generation2-settings.ts';
import { applyHistoricalSql } from '../fixtures/migration/historical-sql.ts';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { readMigrationMarker } from '../fixtures/level3-catalog-storage.ts';
import { SettingsRepository } from '../../packages/plugins/configuration/src/adapters/settings-repository.ts';
import { NamedTerminalFacts } from '../../packages/plugins/terminals/src/adapters/named-facts.ts';
import { TerminalFactsStorage } from '../../packages/plugins/terminals/src/adapters/facts-storage.ts';
import { AXTERM_TERMINAL_THEMES } from '../../packages/plugins/terminals/src/application/theme-presets.ts';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function input() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-settings-transform-'));
  directories.push(directory);
  const path = join(directory, 'product.sqlite'),
    writer = await Generation2Database.open(path);
  return { path, writer };
}
const languageMigrationCases = [
  { source: 'ar', expected: 'en' },
  { source: 'de', expected: 'en' },
  { source: 'en', expected: 'en' },
  { source: 'es', expected: 'en' },
  { source: 'fr', expected: 'en' },
  { source: 'hu', expected: 'en' },
  { source: 'id', expected: 'en' },
  { source: 'ja', expected: 'ja' },
  { source: 'ko', expected: 'en' },
  { source: 'pl', expected: 'en' },
  { source: 'pt-BR', expected: 'en' },
  { source: 'ru', expected: 'en' },
  { source: 'tr', expected: 'en' },
  { source: 'zh-CN', expected: 'zh-CN' },
  { source: 'zh-TW', expected: 'zh-TW' },
] as const;
it.each(languageMigrationCases)(
  'retains frozen locale transformation "$source" to "$expected" in actual owned settings',
  async ({ source, expected }) => {
    const f = await input();
    f.writer.run(
      "UPDATE app_settings SET payload=? WHERE section='appearance'",
      JSON.stringify({ theme: 'dark', language: source }),
    );
    f.writer.close();
    const witness = new DatabaseSync(f.path);
    try {
      applyHistoricalSql(witness, 38);
    } finally {
      witness.close();
    }
    const storage = await ownedStorage(f.path);
    try {
      const settings = new SettingsRepository(await storage.open(productDomains.configuration));
      expect(settings.getSettings().appearance.language).toBe(expected);
    } finally {
      await storage.close();
    }
    expect(await readMigrationMarker(f.path, 38)).toBeDefined();
  },
);
it('retains all removed built-in theme remapping, custom collisions, saved-workspace references and idempotent versions', async () => {
  const f = await input(),
    oldCustomId = '00000000-0000-4000-8000-000000000003',
    oldBuiltInId = '00000000-0000-4000-8000-000000000312',
    now = '2026-09-20T00:00:00.000Z';
  f.writer.run(
    'INSERT INTO terminal_themes(id,name,payload,created_at,updated_at,version) VALUES (?,?,?,?,?,1)',
    oldCustomId,
    'User-created collision',
    JSON.stringify({
      ...AXTERM_TERMINAL_THEMES[0],
      name: 'User-created collision',
      builtIn: false,
    }),
    now,
    now,
  );
  const recorded = new Generation2SettingsWitness().getSettings(),
    background = recorded.terminal.visual.background;
  const tab = (id: string) => ({
    id: randomUUID(),
    title: 'Terminal',
    kind: 'local' as const,
    visual: { themeId: id, background },
    pinned: false,
    paneIndex: 0,
  });
  const layout = (ids: string[]) => ({
    section: 'hosts' as const,
    sidebarOpen: true,
    split: false,
    tabs: ids.map(tab),
    activeTerminalId: null,
    secondaryTerminalId: null,
    layoutMode: 'c1' as const,
    paneTerminalIds: [],
    focusedPane: 0,
  });
  const initial = {
    ...recorded,
    terminal: { ...recorded.terminal, visual: { themeId: oldBuiltInId, background } },
    workspace: {
      ...recorded.workspace,
      layout: layout(['00000000-0000-4000-8000-000000000004']),
      namedWorkspaces: [
        {
          id: randomUUID(),
          name: 'Saved',
          layout: layout([oldCustomId, oldBuiltInId]),
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  };
  const previousVersion = 7;
  for (const [section, payload] of Object.entries(initial))
    if (section !== 'version')
      f.writer.run(
        'INSERT OR REPLACE INTO app_settings(section,payload,version,updated_at) VALUES (?,?,?,?)',
        section,
        JSON.stringify(payload),
        previousVersion,
        now,
      );
  f.writer.close();
  const witness = new DatabaseSync(f.path);
  try {
    applyHistoricalSql(witness, 34);
  } finally {
    witness.close();
  }
  let storage = await ownedStorage(f.path);
  let savedVersion: number;
  try {
    const settings = new SettingsRepository(
      await storage.open(productDomains.configuration),
    ).getSettings();
    savedVersion = settings.version;
    expect(settings.version).toBe(previousVersion + 1);
    expect(settings.terminal.visual.themeId).toBe(DEFAULT_TERMINAL_THEME_ID);
    expect(settings.workspace.layout?.tabs[0]?.visual?.themeId).toBe(DEFAULT_TERMINAL_THEME_ID);
    expect(
      settings.workspace.namedWorkspaces[0]?.layout.tabs.map((item) => item.visual?.themeId),
    ).toEqual([oldCustomId, DEFAULT_TERMINAL_THEME_ID]);
    const themes = new NamedTerminalFacts(
      new TerminalFactsStorage(await storage.open(productDomains.terminals)),
    );
    expect(themes.getJson<TerminalTheme>('terminal_themes', oldCustomId).name).toBe(
      'User-created collision',
    );
  } finally {
    await storage.close();
  }
  storage = await ownedStorage(f.path);
  try {
    expect(
      new SettingsRepository(await storage.open(productDomains.configuration)).getSettings()
        .version,
    ).toBe(savedVersion);
  } finally {
    await storage.close();
  }
});
