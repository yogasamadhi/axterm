import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '../src/index.ts';
import { StorageCommandError } from '@axterm/plugin-api';

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const table = 'axterm_catalog_command_receipts';
async function boot(path = ':memory:', retained = 2000) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path, schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const catalog = await ctx.storage.domain.open(Schema.productDomains.catalog);
  const commands = new Domains.DomainCommands(catalog, table, retained);
  const create = (id: string, name: string) => {
    catalog.run(
      'INSERT INTO host_groups(id,name,created_at,updated_at) VALUES (?,?,?,?)',
      id,
      name,
      '2026-11-05',
      '2026-11-05',
    );
    const cursor = catalog.appendEvent('catalog/group-created', { id });
    return { id, version: 1, cursor };
  };
  return { ctx, catalog, commands, create };
}

it('commits facts/outbox/receipt together and replays a detached outcome without repeating writes', async () => {
  const { catalog, commands, create } = await boot();
  const key = randomUUID();
  const id = randomUUID();
  const apply = vi.fn(() => create(id, 'Group'));
  const observed = vi.fn();
  catalog.subscribe(observed);
  const first = commands.execute(
    key,
    'catalog/createHostGroup',
    { name: 'Group', order: 0, optional: undefined },
    apply,
  );
  first.version = 999;
  const replay = commands.execute(
    key.toUpperCase(),
    'catalog/createHostGroup',
    { order: 0, name: 'Group' },
    apply,
  );
  expect(replay).toEqual({ id, version: 1, cursor: 1 });
  expect(apply).toHaveBeenCalledOnce();
  expect(observed).toHaveBeenCalledOnce();
  expect(catalog.all('SELECT id FROM host_groups')).toEqual([{ id }]);
  expect(() =>
    commands.execute(key, 'catalog/createHostGroup', { name: 'different', order: 0 }, apply),
  ).toThrowError(StorageCommandError);
  expect(() =>
    commands.execute(key, 'catalog/otherOperation', { name: 'Group', order: 0 }, apply),
  ).toThrow('CONFLICT');
  expect(apply).toHaveBeenCalledOnce();
});

it('rolls back shared participant facts, outbox and receipt when a later owner fails', async () => {
  const { ctx, catalog, commands, create } = await boot();
  const configuration = await ctx.storage.domain.open(Schema.productDomains.configuration);
  const key = randomUUID();
  const id = randomUUID();
  const observed = vi.fn();
  catalog.subscribe(observed);
  expect(() =>
    ctx.storage.domain.transaction([catalog.participant, configuration.participant], () => {
      commands.execute(key, 'catalog/createHostGroup', { name: 'Rollback' }, () =>
        create(id, 'Rollback'),
      );
      configuration.run(
        "INSERT INTO app_settings(section,payload,version,updated_at) VALUES ('fixture','{}',1,'2026-11-05')",
      );
      throw new Error('later owner failed');
    }),
  ).toThrow('later owner failed');
  expect(catalog.all('SELECT id FROM host_groups')).toEqual([]);
  expect(catalog.all(`SELECT command_id FROM ${table}`)).toEqual([]);
  expect(configuration.get("SELECT * FROM app_settings WHERE section='fixture'")).toBeUndefined();
  expect(catalog.events(0)).toEqual([]);
  expect(observed).not.toHaveBeenCalled();
  expect(
    commands.execute(key, 'catalog/createHostGroup', { name: 'Rollback' }, () =>
      create(id, 'Rollback'),
    ),
  ).toMatchObject({ id, version: 1 });
});

it('rejects non-JSON, oversized and accessor inputs before invoking application code', async () => {
  const { commands } = await boot();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const getter = vi.fn(() => {
    throw new Error('fixture-private-value');
  });
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  const apply = vi.fn(() => ({ ok: true }));
  for (const value of [
    cycle,
    accessor,
    new Date(),
    Array(2),
    { payload: '界'.repeat(400_000) },
    [undefined],
    NaN,
  ]) {
    expect(() => commands.execute(randomUUID(), 'catalog/createHostGroup', value, apply)).toThrow(
      'INVALID_INPUT',
    );
  }
  expect(getter).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it('rolls back invalid or asynchronous results and revokes late asynchronous transaction writes', async () => {
  const { catalog, commands, create } = await boot();
  const key = randomUUID();
  expect(() =>
    commands.execute(key, 'catalog/createHostGroup', {}, () => {
      create(randomUUID(), 'Invalid result');
      return new Date();
    }),
  ).toThrow('INVALID_RESULT');
  expect(catalog.all('SELECT id FROM host_groups')).toEqual([]);
  expect(catalog.all(`SELECT command_id FROM ${table}`)).toEqual([]);
  const deferred = Promise.withResolvers<void>();
  const late = vi.fn();
  expect(() =>
    commands.execute(key, 'catalog/createHostGroup', {}, async () => {
      await deferred.promise;
      try {
        create(randomUUID(), 'Late write');
      } catch (error) {
        late(error);
      }
      return { ok: true };
    }),
  ).toThrow('INVALID_RESULT');
  deferred.resolve();
  await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());
  expect(late.mock.calls[0]![0]).toMatchObject({ code: 'closed' });
  expect(catalog.all('SELECT id FROM host_groups')).toEqual([]);
  expect(catalog.events(0)).toEqual([]);
});

it('bounds retained outcomes by insertion order and preserves expired-key tombstones against replay', async () => {
  const { catalog, commands, create } = await boot(':memory:', 2);
  const first = randomUUID();
  commands.execute(first, 'catalog/createHostGroup', { name: 'first' }, () =>
    create(randomUUID(), 'first'),
  );
  catalog.run(`UPDATE ${table} SET created_at='9999-12-31' WHERE command_id=?`, first);
  for (const name of ['second', 'third'])
    commands.execute(randomUUID(), 'catalog/createHostGroup', { name }, () =>
      create(randomUUID(), name),
    );
  expect(catalog.get(`SELECT count(*) AS count FROM ${table} WHERE status='completed'`)).toEqual({
    count: 2,
  });
  expect(catalog.get(`SELECT status,result_json FROM ${table} WHERE command_id=?`, first)).toEqual({
    status: 'expired',
    result_json: 'null',
  });
  const replay = vi.fn(() => create(randomUUID(), 'must not replay'));
  expect(() =>
    commands.execute(first, 'catalog/createHostGroup', { name: 'first' }, replay),
  ).toThrow('RECEIPT_EXPIRED');
  expect(replay).not.toHaveBeenCalled();
  expect(catalog.all('SELECT id FROM host_groups')).toHaveLength(3);
});

it('recovers committed receipts from reopened media without storing raw inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-command-journal-'));
  roots.push(root);
  const path = join(root, 'facts.sqlite');
  const first = await boot(path);
  const key = randomUUID();
  const id = randomUUID();
  const input = { name: 'Group', ephemeralInput: 'fixture-not-for-persistence' };
  const result = first.commands.execute(key, 'catalog/createHostGroup', input, () =>
    first.create(id, 'Group'),
  );
  expect(JSON.stringify(first.catalog.all(`SELECT * FROM ${table}`))).not.toContain(
    input.ephemeralInput,
  );
  await first.ctx.fiber.dispose();
  const second = await boot(path);
  const replay = vi.fn(() => ({ id: 'incorrect', version: 1, cursor: 0 }));
  expect(second.commands.execute(key, 'catalog/createHostGroup', input, replay)).toEqual(result);
  expect(replay).not.toHaveBeenCalled();
});
