import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiTerminalThemeDraftSchema } from '@workspace/contracts';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { TerminalThemeRepository } from '../adapters/sqlite/terminal-theme-repository';
import { DARK_TERMINAL_THEME_ID, TerminalThemeService } from './terminal-theme-service';

const databases: ProductDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function persistentService(path: string) {
  const database = await ProductDatabase.open(path);
  databases.push(database);
  return new TerminalThemeService(new TerminalThemeRepository(new ProductRepository(database)));
}

describe('TerminalThemeService', () => {
  it('provides immutable defaults and persists clone, edit and delete with ETags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-themes-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    const service = await persistentService(path);

    expect(service.list()).toHaveLength(4);
    expect(
      service
        .list()
        .slice(0, 4)
        .map(({ name }) => name),
    ).toEqual(['Default', 'Default light', 'Tidal', 'Copper']);
    expect(service.list()[0]?.terminal).toMatchObject({
      background: '#1e1e1e',
      foreground: '#dcdcdc',
      cursor: '#a5e9bf',
    });
    for (const { name, ui, terminal } of service.list())
      expect(aiTerminalThemeDraftSchema.safeParse({ name, ui, terminal }).success).toBe(true);

    const cloned = service.clone(DARK_TERMINAL_THEME_ID, 'Midnight clone');
    expect(cloned).toMatchObject({ name: 'Midnight clone', builtIn: false, version: 1 });
    expect(() => service.update(DARK_TERMINAL_THEME_ID, { name: 'No' }, '"v1"')).toThrow(
      /built-in/i,
    );
    const updated = service.update(cloned.id, { name: 'Night ops' }, '"v1"');
    expect(updated).toMatchObject({ name: 'Night ops', version: 2 });
    expect(() => service.update(cloned.id, { name: 'Stale' }, '"v1"')).toThrow(/changed/i);

    databases.pop()?.close();
    const reopened = await persistentService(path);
    expect(reopened.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: cloned.id, name: 'Night ops' })]),
    );
    reopened.delete(cloned.id, '"v2"');
    expect(reopened.list()).toHaveLength(4);
  });

  it('does not expose retired theme-file import or export methods', async () => {
    const service = await persistentService(':memory:');
    expect('import' in service).toBe(false);
    expect('export' in service).toBe(false);
  });
});
