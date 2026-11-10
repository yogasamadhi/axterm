import { Context } from '@deepseek-ai/cordis';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Generation2Database as ProductDatabase } from '../fixtures/migration/generation2-database.ts';
import * as Schema from '@axterm/data-schema';
import Storage from '@axterm/infra-storage';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';

const contexts: Context[] = [];
const roots: string[] = [];
it('preserves committed forward SQL exactly when appending Catalog import ownership', () => {
  const retained = Schema.forwardMigrations.find((migration) => migration.id === 43)!;
  expect(createHash('sha256').update(retained.sql).digest('hex')).toBe(
    '6f125c90fc4e34e6053fb330810561ed320faa293f14e081d6af9a163c3f40c4',
  );
  expect(
    createHash('sha256')
      .update(Schema.forwardMigrations.find((migration) => migration.id === 44)!.sql)
      .digest('hex'),
  ).toBe('3d30f5ccc7e1b723d09f4cf45486f842cb39b4a285255709f11372285b0de239');
  expect(
    createHash('sha256')
      .update(Schema.forwardMigrations.find((migration) => migration.id === 45)!.sql)
      .digest('hex'),
  ).toBe('5fd1be877b5f2c18d24c49a9561780bb0de43e673147dd12f995ca10a2a3c944');
  expect(
    createHash('sha256')
      .update(Schema.forwardMigrations.find((migration) => migration.id === 46)!.sql)
      .digest('hex'),
  ).toBe('5ee5bb3efb50f755d41db330839bcd44d4b3cb01354042a20257ae3d973982d5');
  const retainedHashes = {
    47: '3c7cfafa7e3206a92eb06ac426e2668e1e041ff42c12b1cd6a85da49ff017660',
    48: '49a31a47899b8ef87ace680315d3718ccabe85e98b4fd4429a5c8bbb5ac7f0b6',
    49: '531a0692114472b0073accbcbc7cbd16018427a320be8e0aa8084ed691fd30bb',
    50: '8975830f28f968d0b6912f35c7d18af900c9344bd4ce5bc58c6fb0e7d9bea0d4',
    51: 'ed00242ca03a07ed148a9dcc9a94340e2083663ecfa7e772678a72edc0ca8193',
    52: 'c4e5110bc91066762382186be80d4e038cc952ed6cd1e6bf184f135eb83fe350',
    53: 'ff414ec7a402f3f47cccefb23dad0a708951bd3b84211d520f24bda529fc9e62',
    54: 'f80184f86248eb723e190d4eac25eb56bc4d3b0c1ec18cb860b5ccf8c027cac4',
  };
  for (const [id, hash] of Object.entries(retainedHashes))
    expect(
      createHash('sha256')
        .update(Schema.forwardMigrations.find((migration) => migration.id === Number(id))!.sql)
        .digest('hex'),
    ).toBe(hash);
  expect(Schema.forwardMigrations.map((migration) => migration.id)).toEqual([
    43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  ]);
});
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function file() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-product-storage-'));
  roots.push(root);
  return join(root, 'product.sqlite');
}
async function boot(path: string) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path, schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  return ctx;
}

it('preserves all 42 existing migration checksums and assigns every product table exactly once', async () => {
  const path = await file();
  const previous = await ProductDatabase.open(path);
  const checksums = previous.all<{ key: string; value: string }>(
    "SELECT key,value FROM app_meta WHERE key LIKE 'migration:%' ORDER BY key",
  );
  const tables = previous.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  previous.run(
    "INSERT INTO app_settings(section,payload,version,updated_at) VALUES ('fixture','{\"value\":\"preserved\"}',1,'2026-11-05')",
  );
  previous.close();
  expect(checksums).toHaveLength(42);
  expect(Schema.SCHEMA_VERSION).toBe(42);
  const exported = Schema.legacyMigrations
    .map((migration) => ({
      key: `migration:${migration.id}`,
      value: createHash('sha256').update(migration.sql).digest('hex'),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  expect(exported).toEqual(checksums);
  expect(Schema.productBootstrap.tables.map((entry) => entry.table).sort()).toEqual(
    [...tables.map((entry) => entry.name), ...Schema.forwardTableNames].sort(),
  );
  expect(new Set(Schema.productBootstrap.tables.map((entry) => entry.table)).size).toBe(
    tables.length + Schema.forwardTableNames.length,
  );
  const ctx = await boot(path);
  const configuration = await ctx.storage.domain.open(Schema.productDomains.configuration);
  expect(configuration.get('SELECT payload FROM app_settings WHERE section=?', 'fixture')).toEqual({
    payload: '{"value":"preserved"}',
  });
  await configuration.close();
  for (const spec of Object.values(Schema.productDomains)) {
    const domain = await ctx.storage.domain.open(spec);
    await domain.close();
  }
  const check = new DatabaseSync(path);
  expect(
    check.prepare("SELECT key,value FROM app_meta WHERE key LIKE 'migration:%' ORDER BY key").all(),
  ).toEqual(
    [
      ...checksums,
      ...Schema.forwardMigrations.map((migration) => ({
        key: `migration:${migration.id}`,
        value: createHash('sha256').update(migration.sql).digest('hex'),
      })),
    ].sort((a, b) => a.key.localeCompare(b.key)),
  );
  expect(
    check.prepare("SELECT value FROM app_meta WHERE key='axterm:schema-generation'").get(),
  ).toEqual({ value: '2' });
  expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  check.close();
});

it('initializes a fresh product database through the same immutable migration ledger', async () => {
  const path = await file();
  const ctx = await boot(path);
  const catalogue = await ctx.storage.domain.open(Schema.productDomains.catalog);
  catalogue.transaction(() => {
    catalogue.run(
      'INSERT INTO host_groups(id,name,created_at,updated_at) VALUES (?,?,?,?)',
      'group-one',
      'Group',
      '2026-11-05',
      '2026-11-05',
    );
    catalogue.appendEvent('catalog/group-created', { id: 'group-one' });
  });
  expect(catalogue.get('SELECT name FROM host_groups WHERE id=?', 'group-one')).toEqual({
    name: 'Group',
  });
  const check = new DatabaseSync(path);
  expect(
    check.prepare("SELECT count(*) AS count FROM app_meta WHERE key LIKE 'migration:%'").get(),
  ).toEqual({ count: Schema.PRODUCT_SCHEMA_VERSION });
  expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  check.close();
});

it('assigns existing AI providers and runs explicitly to Pi without rewriting references or visible facts', async () => {
  const path = await file();
  const previous = await ProductDatabase.open(path);
  const payload = JSON.stringify({
    name: 'Existing',
    baseUrl: 'http://127.0.0.1:1234',
    credentialRef: 'preserve_this_ref',
    enabled: true,
  });
  previous.run(
    'INSERT INTO ai_providers(id,name,payload,created_at,updated_at,version) VALUES (?,?,?,?,?,?)',
    'provider',
    'Existing',
    payload,
    '2026-10-01',
    '2026-10-02',
    7,
  );
  previous.run(
    "INSERT INTO ai_runs(id,state,use_case,request,result,created_at,updated_at,version) VALUES (?,'succeeded','chat','{}',?,?,?,?)",
    'run',
    'visible answer',
    '2026-10-01',
    '2026-10-02',
    4,
  );
  previous.close();
  const ctx = await boot(path);
  const ai = await ctx.storage.domain.open(Schema.productDomains.ai);
  const provider = ai.get<{ payload: string; version: number; updated_at: string }>(
    'SELECT payload,version,updated_at FROM ai_providers WHERE id=?',
    'provider',
  )!;
  expect(JSON.parse(provider.payload)).toEqual({ ...JSON.parse(payload), engineId: 'pi' });
  expect(provider.version).toBe(7);
  expect(provider.updated_at).toBe('2026-10-02');
  expect(
    ai.get('SELECT engine_id,result,version,updated_at FROM ai_runs WHERE id=?', 'run'),
  ).toEqual({ engine_id: 'pi', result: 'visible answer', version: 4, updated_at: '2026-10-02' });
  expect(ai.all('SELECT * FROM axterm_ai_run_intents')).toEqual([]);
  expect(ai.all('SELECT * FROM axterm_ai_run_log')).toEqual([]);
  await ai.close();
});

it('moves existing collection revisions to their sole owners, retains legacy values and rejects cross-owner writes', async () => {
  const path = await file();
  const previous = await ProductDatabase.open(path);
  for (const [key, value] of [
    ['bookmark-tree:revision', '21'],
    ['connection-history:revision', '14'],
    ['command-history:revision', '8'],
  ])
    previous.run('UPDATE app_meta SET value=? WHERE key=?', value!, key!);
  previous.close();
  const ctx = await boot(path);
  const catalog = await ctx.storage.domain.open(Schema.productDomains.catalog);
  const terminals = await ctx.storage.domain.open(Schema.productDomains.terminals);
  const configuration = await ctx.storage.domain.open(Schema.productDomains.configuration);
  expect(catalog.all('SELECT name,revision FROM axterm_catalog_revisions ORDER BY name')).toEqual([
    { name: 'bookmarks', revision: 21 },
    { name: 'connections', revision: 14 },
  ]);
  expect(
    terminals.get('SELECT revision FROM axterm_terminal_revisions WHERE name=?', 'commands'),
  ).toEqual({ revision: 8 });
  expect(() => configuration.run('DELETE FROM axterm_catalog_revisions')).toThrow();
  const reportId = randomUUID();
  catalog.run(
    'INSERT INTO axterm_catalog_import_reports VALUES (?,?,?)',
    reportId,
    '{}',
    new Date().toISOString(),
  );
  expect(catalog.get('SELECT report_id FROM axterm_catalog_import_reports')).toEqual({
    report_id: reportId,
  });
  expect(() => configuration.run('DELETE FROM axterm_catalog_import_reports')).toThrow();
  expect(() => terminals.get('SELECT result_json FROM axterm_catalog_import_reports')).toThrow();

  expect(() => catalog.get('SELECT value FROM app_meta')).toThrow();
  expect(() => catalog.get('SELECT revision FROM axterm_terminal_revisions')).toThrow();
  catalog.run('UPDATE axterm_catalog_revisions SET revision=revision+1 WHERE name=?', 'bookmarks');
  const check = new DatabaseSync(path);
  expect(
    check.prepare("SELECT value FROM app_meta WHERE key='bookmark-tree:revision'").get(),
  ).toEqual({ value: '21' });
  expect(
    check.prepare('SELECT version FROM axterm_storage_domains WHERE name=?').get('catalog'),
  ).toEqual({ version: 3 });
  check.close();
  await catalog.close();
  await terminals.close();
  await configuration.close();
  const reopened = await ctx.storage.domain.open(Schema.productDomains.catalog);
  expect(
    reopened.get('SELECT revision FROM axterm_catalog_revisions WHERE name=?', 'bookmarks'),
  ).toEqual({ revision: 22 });
});

it.each(['missing', '0', '-1', '1e3', '1.5', '9007199254740992', 'not-a-revision'])(
  'rolls back forward tables and the migration marker when legacy revisions are invalid: %s',
  async (value) => {
    const path = await file();
    const previous = await ProductDatabase.open(path);
    if (value === 'missing')
      previous.run("DELETE FROM app_meta WHERE key='command-history:revision'");
    else previous.run("UPDATE app_meta SET value=? WHERE key='command-history:revision'", value);
    const before = previous.all('SELECT key,value FROM app_meta ORDER BY key');
    previous.close();
    await expect(boot(path)).rejects.toBeInstanceOf(Error);
    const check = new DatabaseSync(path);
    expect(check.prepare('SELECT key,value FROM app_meta ORDER BY key').all()).toEqual(before);
    expect(
      check
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'axterm_catalog_%' OR name LIKE 'axterm_terminal_%' OR name='axterm_storage_format'",
        )
        .all(),
    ).toEqual([]);
    check.close();
  },
);

it.each(['generation', 'checksum', 'missing', 'future'] as const)(
  'rejects unsupported or damaged product metadata before adding storage tables: %s',
  async (kind) => {
    const path = await file();
    const database = await ProductDatabase.open(path);
    if (kind === 'generation')
      database.run("UPDATE app_meta SET value='1' WHERE key='axterm:schema-generation'");
    if (kind === 'checksum')
      database.run("UPDATE app_meta SET value='broken' WHERE key='migration:42'");
    if (kind === 'missing') database.run("DELETE FROM app_meta WHERE key='migration:40'");
    if (kind === 'future') database.run("INSERT INTO app_meta VALUES ('migration:999','unknown')");
    const before = database.all('SELECT key,value FROM app_meta ORDER BY key');
    database.close();
    await expect(boot(path)).rejects.toBeInstanceOf(Error);
    const check = new DatabaseSync(path);
    expect(check.prepare('SELECT key,value FROM app_meta ORDER BY key').all()).toEqual(before);
    expect(
      check
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='axterm_storage_format'")
        .get(),
    ).toEqual({ count: 0 });
    check.close();
  },
);
