import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_THEME_ID } from '@workspace/contracts';
import { AXTERM_TERMINAL_THEMES } from '@workspace/shared';
import { ProductDatabase } from './database';
import { ProductRepository, etagFor } from './product-repository';
import { TerminalThemeRepository } from './terminal-theme-repository';

const roots: string[] = [];
const legacyId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('independent terminal-theme catalog migration', () => {
  it('maps removed built-ins in global and saved workspaces while retaining custom themes and a recoverable pre-migration backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-theme-catalog-'));
    roots.push(root);
    const path = join(root, 'product.sqlite');
    let database = await ProductDatabase.open(path);
    let products = new ProductRepository(database);
    const oldCustomId = legacyId(3);
    const oldBuiltInId = legacyId(312);
    const now = '2026-09-20T00:00:00.000Z';
    database.run(
      `INSERT INTO terminal_themes(id, name, payload, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
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
    const background = products.getSettings().terminal.visual.background;
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
    products.updateSettings(
      {
        terminal: { visual: { themeId: oldBuiltInId, background } },
        workspace: {
          layout: layout([legacyId(4)]),
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
      },
      etagFor(products.getSettings().version),
    );
    const previousVersion = products.getSettings().version;
    database.run("DELETE FROM app_meta WHERE key = 'migration:34'");
    database.close();

    database = await ProductDatabase.open(path);
    products = new ProductRepository(database);
    const settings = products.getSettings();
    expect(settings.version).toBe(previousVersion + 1);
    expect(settings.terminal.visual.themeId).toBe(DEFAULT_TERMINAL_THEME_ID);
    expect(settings.workspace.layout?.tabs[0]?.visual?.themeId).toBe(DEFAULT_TERMINAL_THEME_ID);
    expect(
      settings.workspace.namedWorkspaces[0]?.layout.tabs.map((item) => item.visual?.themeId),
    ).toEqual([oldCustomId, DEFAULT_TERMINAL_THEME_ID]);
    expect(new TerminalThemeRepository(products).get(oldCustomId).name).toBe(
      'User-created collision',
    );
    database.close();

    const backups = (await readdir(root)).filter((entry) =>
      /^product\.sqlite\.pre-migration-34\.bak(?:\.[0-9a-f-]{36})?$/u.test(entry),
    );
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(dirname(path), backups[0]!), { readOnly: true });
    try {
      const row = backup
        .prepare("SELECT payload FROM app_settings WHERE section = 'terminal'")
        .get() as {
        payload: string;
      };
      expect(JSON.parse(row.payload).visual.themeId).toBe(oldBuiltInId);
    } finally {
      backup.close();
    }

    database = await ProductDatabase.open(path);
    expect(new ProductRepository(database).getSettings().version).toBe(settings.version);
    database.close();
  });
});
