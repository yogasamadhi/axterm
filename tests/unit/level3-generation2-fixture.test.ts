import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import {
  Generation2Database,
  seedGeneration2History,
} from '../fixtures/migration/generation2-database.ts';
import { Generation2Vault } from '../fixtures/migration/generation2-vault.ts';
import frozen from '../fixtures/migration/generation2-migrations.json';
it('creates an independent frozen 42-migration generation 2 input and refuses an existing medium', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-generation2-fixture-'));
  try {
    const path = join(root, 'input.sqlite'),
      db = await Generation2Database.open(path);
    expect(db.get("SELECT value FROM app_meta WHERE key='axterm:schema-generation'")).toEqual({
      value: '2',
    });
    const actual = db.all<{ key: string; value: string }>(
      "SELECT key,value FROM app_meta WHERE key LIKE 'migration:%'",
    );
    expect(actual).toHaveLength(42);
    for (const record of frozen.migrations)
      expect(actual).toContainEqual({ key: `migration:${record.id}`, value: record.sha256 });
    db.close();
    const bytes = await readFile(path);
    await expect(Generation2Database.open(path)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('writes the historical credential envelope readable by the new Vault without replacing key or ciphertext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-generation2-vault-fixture-'));
  let vault: EncryptedVault | undefined;
  try {
    const old = new Generation2Vault(root);
    await old.open();
    const entry = await old.put({
      kind: 'password',
      label: 'Fixture',
      secret: 'GENERATION2_FIXTURE_CANARY',
    });
    old.close();
    const encrypted = await readFile(join(root, entry.ref + '.bin')),
      key = await readFile(join(root, 'master.key'));
    vault = new EncryptedVault(root);
    await vault.open();
    expect(await vault.get(entry.ref)).toBe('GENERATION2_FIXTURE_CANARY');
    expect((await vault.list()).map((v) => v.ref)).toContain(entry.ref);
    await vault.close();
    vault = undefined;
    expect(await readFile(join(root, 'master.key'))).toEqual(key);
    expect(
      createHash('sha256')
        .update(await readFile(join(root, entry.ref + '.bin')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(encrypted).digest('hex'));
    expect(encrypted.toString()).not.toContain('GENERATION2_FIXTURE_CANARY');
  } finally {
    await vault?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('seeds the recorded generation 2 history rows and collection revisions without loading legacy services', async () => {
  const database = await Generation2Database.open(':memory:');
  try {
    seedGeneration2History(database);
    for (const table of ['hosts', 'recent_connections', 'command_history'])
      expect(database.get(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 1 });
    expect(
      database.get("SELECT value FROM app_meta WHERE key='connection-history:revision'"),
    ).toEqual({ value: '2' });
    expect(database.get("SELECT value FROM app_meta WHERE key='command-history:revision'")).toEqual(
      { value: '2' },
    );
    expect(
      database.get("SELECT COUNT(*) AS count FROM app_meta WHERE key LIKE 'migration:%'"),
    ).toEqual({ count: 42 });
  } finally {
    database.close();
  }
});
