import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { productDomains } from '@axterm/data-schema';
import { copyGeneration2Home } from '../../apps/desktop-host/src/copy/home.ts';
import { SettingsRepository } from '../../packages/plugins/configuration/src/adapters/settings-repository.ts';
import { HostRepository } from '../../packages/plugins/catalog/src/adapters/host-repository.ts';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { applyHistoricalSql } from '../fixtures/migration/historical-sql.ts';
import {
  MIGRATION_FAILURE_SECRET,
  REMOVED_BUILT_IN_THEME_ID,
  seedFailingLocalProfile,
  vaultFileHashes,
} from '../fixtures/migration/failing-local-profile.ts';
it('keeps failing historical SQL and source Vault intact, refuses incomplete copy and permits explicit input repair', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-migration-failure-owned-'));
  try {
    const source = join(directory, 'source'),
      home = join(directory, 'new'),
      f = await seedFailingLocalProfile(source);
    await expect(copyGeneration2Home({ source, home })).rejects.toThrow('UNSUPPORTED_SCHEMA');
    await expect(access(join(home, 'data-v2', 'axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(f.databasePath)).toEqual(f.databaseBefore);
    expect(await vaultFileHashes(f.vaultDirectory)).toEqual(f.vaultBefore);
    const failed = new DatabaseSync(f.databasePath);
    try {
      expect(() => applyHistoricalSql(failed, 34)).toThrow('synthetic migration 34 failure');
    } finally {
      failed.close();
    }
    expect(await readFile(f.databasePath)).toEqual(f.databaseBefore);
    expect(await vaultFileHashes(f.vaultDirectory)).toEqual(f.vaultBefore);
    const unchanged = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      expect(
        unchanged.prepare("SELECT value FROM app_meta WHERE key='migration:34'").get(),
      ).toBeUndefined();
      expect(
        JSON.parse(
          String(
            unchanged.prepare("SELECT payload FROM app_settings WHERE section='terminal'").get()!
              .payload,
          ),
        ).visual.themeId,
      ).toBe(REMOVED_BUILT_IN_THEME_ID);
    } finally {
      unchanged.close();
    }
    const vault = new EncryptedVault(f.vaultDirectory);
    try {
      await vault.open();
      expect(await vault.get(f.credentialRef)).toBe(MIGRATION_FAILURE_SECRET);
    } finally {
      await vault.close();
    }
    expect(await vaultFileHashes(f.vaultDirectory)).toEqual(f.vaultBefore);
    const repair = new DatabaseSync(f.databasePath);
    try {
      repair.exec('DROP TRIGGER migration_34_failure');
      applyHistoricalSql(repair, 34);
    } finally {
      repair.close();
    }
    const storage = await ownedStorage(f.databasePath);
    try {
      const settings = new SettingsRepository(await storage.open(productDomains.configuration));
      const hosts = new HostRepository(
        new CatalogStorage(await storage.open(productDomains.catalog)),
        () => [],
      );
      expect(settings.getSettings().terminal.visual.themeId).not.toBe(REMOVED_BUILT_IN_THEME_ID);
      expect(hosts.listHosts().map(({ name }) => name)).toContain('preserved-migration-host');
    } finally {
      await storage.close();
    }
    expect(await vaultFileHashes(f.vaultDirectory)).toEqual(f.vaultBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
