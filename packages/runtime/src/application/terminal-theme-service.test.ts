import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { TerminalThemeRepository } from '../adapters/sqlite/terminal-theme-repository';
import {
  DARK_TERMINAL_THEME_ID,
  TerminalThemeService,
  parseElectermTheme,
  serializeElectermTheme,
} from './terminal-theme-service';

const databases: ProductDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function persistentService(path: string, host?: unknown) {
  const database = await ProductDatabase.open(path);
  databases.push(database);
  return new TerminalThemeService(
    new TerminalThemeRepository(new ProductRepository(database)),
    host as never,
  );
}

describe('TerminalThemeService', () => {
  it('provides immutable defaults and persists clone, edit and delete with ETags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-themes-'));
    directories.push(directory);
    const path = join(directory, 'product.sqlite');
    const service = await persistentService(path);

    expect(service.list()).toHaveLength(312);
    expect(
      service
        .list()
        .slice(0, 10)
        .map(({ name }) => name),
    ).toEqual([
      'Default',
      'Default light',
      '3024 Day',
      '3024 Night',
      'Aardvark Blue',
      'Abernathy',
      'Adventure',
      'AdventureTime',
      'Afterglow',
      'Alabaster',
    ]);
    expect(service.list()[0]?.terminal).toMatchObject({
      background: '#0b1114',
      foreground: '#d6dde2',
      cursor: '#78e39b',
    });

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
    expect(reopened.list()).toHaveLength(312);
  });

  it('round-trips the Electerm text format through operation-scoped file grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-theme-files-'));
    directories.push(directory);
    const exportPath = join(directory, 'theme.txt');
    const base = (await persistentService(':memory:')).list()[0]!;
    const source = serializeElectermTheme({ ...base, name: 'Imported dusk' });
    const host = {
      readGrantedText: vi.fn(async () => ({ name: 'dusk.txt', content: source })),
      resolveGrant: vi.fn(async () => ({
        path: exportPath,
        kind: 'save-target',
        permissions: ['write'],
      })),
    };
    const service = await persistentService(':memory:', host);

    const imported = await service.import('grant-read');
    const result = await service.export(imported.id, 'grant-write');
    const exported = await readFile(exportPath, 'utf8');

    expect(imported).toMatchObject({ name: 'Imported dusk', builtIn: false });
    expect(result.bytes).toBe(Buffer.byteLength(exported));
    expect(parseElectermTheme(exported)).toEqual({
      name: imported.name,
      terminal: imported.terminal,
      ui: imported.ui,
    });
    expect(host.readGrantedText).toHaveBeenCalledWith('grant-read');
    expect(host.resolveGrant).toHaveBeenCalledWith('grant-write');
  });

  it('rejects missing, unsupported and invalid theme properties', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-bad-theme-'));
    directories.push(directory);
    await writeFile(join(directory, 'placeholder'), '');
    expect(() => parseElectermTheme('themeName=bad\nunknown=#fff')).toThrow(/unsupported/i);
    expect(() => parseElectermTheme('themeName=bad\nmain=#fff')).toThrow();
    const validTheme = (await persistentService(':memory:')).list()[0]!;
    expect(() =>
      parseElectermTheme(
        serializeElectermTheme({
          ...validTheme,
          terminal: {
            ...validTheme.terminal,
            red: 'rgba(999, 0, 0, 1)',
          },
        }),
      ),
    ).toThrow();
  });
});
