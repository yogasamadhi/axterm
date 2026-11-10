import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { RelationalStorageBackend } from '@axterm/infra-storage-relational';
import { productBootstrap, productDomains, forwardMigrations } from '@axterm/data-schema';
const stageTables = ['axterm_terminal_stage_keys', 'axterm_terminal_stages'];
const previousPlan = {
  ...productBootstrap,
  migrations: productBootstrap.migrations.filter((m) => m.id <= 52),
  tables: productBootstrap.tables
    .filter((row) => !productDomains.terminalAssets.tables.some((table) => table === row.table))
    .map((row) => (stageTables.includes(row.table) ? { ...row, domain: 'terminals' } : row)),
};
it('forward-migrates retained stage rows while admitting one independent facts and stage owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-stage-domain-')),
    path = join(root, 'database.sqlite');
  let previous: RelationalStorageBackend | undefined, next: RelationalStorageBackend | undefined;
  try {
    previous = new RelationalStorageBackend(path, previousPlan);
    await previous.initialize();
    const old = await previous.sql.open({
      ...productDomains.terminals,
      tables: [...productDomains.terminals.tables, ...stageTables],
    });
    const id = randomUUID(),
      generation = randomUUID();
    old.run(
      'INSERT INTO axterm_terminal_stage_keys(profile_name,key) VALUES (?,?)',
      'web',
      Buffer.alloc(32, 7),
    );
    old.run(
      'INSERT INTO axterm_terminal_stages VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      'web',
      generation,
      'a'.repeat(64),
      'xmodem',
      'Retained',
      '1',
      '2',
      'failed',
      0,
    );
    await old.close();
    await previous.close();
    previous = undefined;
    next = new RelationalStorageBackend(path, productBootstrap);
    await next.initialize();
    const facts = await next.sql.open(productDomains.terminals),
      stages = await next.sql.open(productDomains.terminalTransferStages);
    expect(
      stages.get<{ name: string }>('SELECT name FROM axterm_terminal_stages WHERE id=?', id),
    ).toEqual({ name: 'Retained' });
    expect(() => facts.get('SELECT * FROM axterm_terminal_stages')).toThrow();
    await expect(next.sql.open(productDomains.terminalTransferStages)).rejects.toMatchObject({
      code: 'ownership-conflict',
    });
    await stages.close();
    await facts.close();
  } finally {
    await next?.close();
    await previous?.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('does not transfer stage ownership away from an unexpected package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-stage-domain-reject-')),
    path = join(root, 'database.sqlite');
  let current: RelationalStorageBackend | undefined;
  try {
    const old = new RelationalStorageBackend(path, previousPlan);
    await old.initialize();
    await old.close();
    const db = new DatabaseSync(path);
    db.prepare(
      "UPDATE axterm_storage_owners SET owner='@fixture/foreign' WHERE name='axterm_terminal_stages'",
    ).run();
    db.close();
    current = new RelationalStorageBackend(path, productBootstrap);
    await expect(current.initialize()).rejects.toMatchObject({ code: 'ownership-conflict' });
  } finally {
    await current?.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('retains the committed stage table migration while appending its ownership transition', () => {
  const stage = forwardMigrations.find((m) => m.id === 52)!;
  expect(stage).toBeDefined();
  expect(createHash('sha256').update(stage.sql).digest('hex')).toBe(
    'c4e5110bc91066762382186be80d4e038cc952ed6cd1e6bf184f135eb83fe350',
  );
  expect(
    forwardMigrations
      .filter((migration) => migration.id > 52)
      .slice(0, 2)
      .map((migration) => migration.id),
  ).toEqual([53, 54]);
});
