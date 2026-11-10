import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aiTerminalThemeDraftSchema } from '@axterm/plugin-api/ai';
import { ownedStorage } from '../../../../tests/fixtures/level3-owned-storage.ts';
import { productDomains } from '@axterm/data-schema';
import { TerminalFactsStorage } from '../src/adapters/facts-storage.ts';
import { NamedTerminalFacts } from '../src/adapters/named-facts.ts';
import { TerminalThemeRepository } from '../src/adapters/terminal-theme-repository.ts';
import {
  DARK_TERMINAL_THEME_ID,
  TerminalThemeService,
} from '../src/application/terminal-theme-service.ts';

const databases: (() => Promise<void>)[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const close of databases.splice(0).reverse()) await close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function persistentService(path: string) {
  const storage = await ownedStorage(path);
  databases.push(storage.close);
  const domain = await storage.open(productDomains.terminals);
  return new TerminalThemeService(
    new TerminalThemeRepository(new NamedTerminalFacts(new TerminalFactsStorage(domain))),
  );
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

    await databases.pop()?.();
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
