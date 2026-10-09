import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductDatabase } from './database';
import { ProductRepository } from './product-repository';

const roots: string[] = [];

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('retired application-language migration', () => {
  it.each(languageMigrationCases)(
    'migrates persisted locale "$source" to "$expected" with a recoverable backup',
    async ({ source, expected }) => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-language-catalog-'));
      roots.push(root);
      const path = join(root, 'product.sqlite');
      let database = await ProductDatabase.open(path);
      database.run(
        `UPDATE app_settings SET payload = '{"theme":"dark","language":"${source}"}' WHERE section = 'appearance'`,
      );
      database.run("DELETE FROM app_meta WHERE key = 'migration:38'");
      database.close();

      database = await ProductDatabase.open(path);
      expect(new ProductRepository(database).getSettings().appearance.language).toBe(expected);
      expect(database.get("SELECT value FROM app_meta WHERE key = 'migration:38'")).toBeDefined();
      database.close();

      const backups = (await readdir(root)).filter((entry) =>
        entry.startsWith('product.sqlite.pre-migration-38.bak'),
      );
      expect(backups).toHaveLength(1);
      const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
      try {
        const row = backup
          .prepare("SELECT payload FROM app_settings WHERE section = 'appearance'")
          .get() as { payload: string };
        expect(JSON.parse(row.payload)).toMatchObject({ language: source });
      } finally {
        backup.close();
      }
    },
  );
});
