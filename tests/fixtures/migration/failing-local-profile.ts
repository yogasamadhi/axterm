import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CredentialVault } from '../../../apps/desktop/src/main/host-capabilities/credential-vault';
import { ProductDatabase } from '../../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
} from '../../../packages/runtime/src/adapters/sqlite/product-repository';

export const MIGRATION_FAILURE_SECRET = 'synthetic-migration-failure-vault-secret';
export const REMOVED_BUILT_IN_THEME_ID = '00000000-0000-4000-8000-000000000003';

export interface FailingLocalProfile {
  databasePath: string;
  vaultDirectory: string;
  credentialRef: string;
  databaseBefore: Buffer;
  vaultBefore: Record<string, string>;
}

export async function vaultFileHashes(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(directory)).sort().map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(join(directory, name)))
          .digest('hex'),
      ]),
    ),
  );
}

export async function seedFailingLocalProfile(userData: string): Promise<FailingLocalProfile> {
  const vaultDirectory = join(userData, 'vault-v2');
  const databasePath = join(userData, 'data-v2', 'axterm.sqlite');
  await mkdir(join(userData, 'data-v2'), { recursive: true });
  const vault = new CredentialVault(vaultDirectory);
  await vault.open();
  const credential = await vault.put({
    kind: 'sshPassword',
    label: 'Migration failure fixture',
    secret: MIGRATION_FAILURE_SECRET,
  });
  vault.close();

  const database = await ProductDatabase.open(databasePath);
  try {
    database.recordAppVersion('0.9.0');
    const repository = new ProductRepository(database);
    repository.createHost({
      name: 'preserved-migration-host',
      hostname: 'migration.example.test',
      username: 'fixture',
      authType: 'password',
      credentialRef: credential.ref,
    });
    const settings = repository.getSettings();
    repository.updateSettings(
      {
        terminal: {
          visual: { ...settings.terminal.visual, themeId: REMOVED_BUILT_IN_THEME_ID },
        },
      },
      etagFor(settings.version),
    );
    database.run("DELETE FROM app_meta WHERE key='migration:34'");
  } finally {
    database.close();
  }

  const connection = new DatabaseSync(databasePath);
  try {
    connection.exec(`
      CREATE TRIGGER migration_34_failure
      BEFORE UPDATE OF payload ON app_settings
      WHEN OLD.section = 'terminal'
      BEGIN SELECT RAISE(ABORT, 'synthetic migration 34 failure'); END;
    `);
  } finally {
    connection.close();
  }
  return {
    databasePath,
    vaultDirectory,
    credentialRef: credential.ref,
    databaseBefore: await readFile(databasePath),
    vaultBefore: await vaultFileHashes(vaultDirectory),
  };
}
