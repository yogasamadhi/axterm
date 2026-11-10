import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Generation2Vault as CredentialVault } from './generation2-vault.ts';
import { Generation2Database as ProductDatabase } from './generation2-database.ts';
import historicalSettings from './generation2-settings.json';

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
  await mkdir(join(userData, 'data-v2'), { recursive: true, mode: 0o700 });
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
    // Fixed historical input only; no application repository or migration runner.
    const now = new Date().toISOString();
    database.run("INSERT INTO app_meta(key,value) VALUES('app:current-version','0.9.0')");
    database.run(
      'INSERT INTO hosts(id,name,hostname,username,auth_type,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(),
      'preserved-migration-host',
      'migration.example.test',
      'fixture',
      'password',
      credential.ref,
      now,
      now,
    );
    database.run(
      "INSERT INTO app_settings(section,payload,version,updated_at) VALUES('terminal',?,1,?) ON CONFLICT(section) DO UPDATE SET payload=excluded.payload",
      JSON.stringify({
        ...historicalSettings.initial.terminal,
        visual: {
          ...historicalSettings.initial.terminal.visual,
          themeId: REMOVED_BUILT_IN_THEME_ID,
        },
      }),
      now,
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
