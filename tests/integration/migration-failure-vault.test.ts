import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { CredentialVault } from '../../apps/desktop/src/main/host-capabilities/credential-vault';
import {
  MigrationError,
  ProductDatabase,
} from '../../packages/runtime/src/adapters/sqlite/database';
import { ProductRepository } from '../../packages/runtime/src/adapters/sqlite/product-repository';
import {
  MIGRATION_FAILURE_SECRET,
  REMOVED_BUILT_IN_THEME_ID,
  seedFailingLocalProfile,
  vaultFileHashes,
} from '../fixtures/migration/failing-local-profile';

it('keeps the SQLite rollback copy and local Vault intact when a risky migration aborts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-migration-failure-'));
  try {
    const fixture = await seedFailingLocalProfile(directory);
    await expect(ProductDatabase.open(fixture.databasePath)).rejects.toBeInstanceOf(MigrationError);
    const backupPath = `${fixture.databasePath}.pre-migration-34.bak`;
    await access(backupPath);
    expect(await readFile(backupPath)).toEqual(fixture.databaseBefore);
    expect(await readFile(fixture.databasePath)).toEqual(fixture.databaseBefore);
    expect(await vaultFileHashes(fixture.vaultDirectory)).toEqual(fixture.vaultBefore);

    const unchanged = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(
        unchanged.prepare("SELECT value FROM app_meta WHERE key='migration:34'").get(),
      ).toBeUndefined();
      const terminal = unchanged
        .prepare("SELECT payload FROM app_settings WHERE section='terminal'")
        .get() as {
        payload: string;
      };
      expect(JSON.parse(terminal.payload).visual.themeId).toBe(REMOVED_BUILT_IN_THEME_ID);
    } finally {
      unchanged.close();
    }

    const vault = new CredentialVault(fixture.vaultDirectory);
    await vault.open();
    expect(await vault.get(fixture.credentialRef)).toBe(MIGRATION_FAILURE_SECRET);
    vault.close();

    const repair = new DatabaseSync(fixture.databasePath);
    repair.exec('DROP TRIGGER migration_34_failure');
    repair.close();
    const recovered = await ProductDatabase.open(fixture.databasePath);
    try {
      const repository = new ProductRepository(recovered);
      expect(repository.getSettings().terminal.visual.themeId).not.toBe(REMOVED_BUILT_IN_THEME_ID);
      expect(repository.listHosts().map(({ name }) => name)).toContain('preserved-migration-host');
    } finally {
      recovered.close();
    }
    expect(await readFile(backupPath)).toEqual(fixture.databaseBefore);
    expect(await vaultFileHashes(fixture.vaultDirectory)).toEqual(fixture.vaultBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
