import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineDomain,
  domainTable,
  descriptorOf,
  type KvUnit,
  type DomainChanged,
} from '@axterm/plugin-api';
import Storage from '@axterm/infra-storage';
import * as Sqlite from '@axterm/infra-storage-sqlite';
import * as Domains from '@axterm/infra-storage-domain';

const contexts: Context[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function path(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'axterm-storage-'));
  directories.push(root);
  return join(root, 'records.sqlite');
}
async function boot(filename = ':memory:', backend = 'sqlite') {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Sqlite, { path: filename, journalMode: 'wal' });
  const provider = ctx.plugin(Domains, { backend });
  await provider;
  return { ctx, provider };
}
function spec(owner = '@fixture/notes') {
  return defineDomain({
    owner,
    name: 'notes',
    version: 1,
    global: { schema: z.object({ title: z.string() }), initial: { title: 'Initial' } },
    tables: {
      entries: domainTable<string, { count: number }>(z.object({ count: z.number().int() })),
    },
  });
}

it('validates ownership and derived-data policy before media access', () => {
  expect(() => defineDomain({ ...spec(), owner: '' })).toThrow('owner');
  expect(() => defineDomain({ ...spec(), invalidRecords: 'backup-and-skip' })).toThrow('derived');
  expect(() =>
    defineDomain({ ...spec(), global: { schema: z.string().nullable(), initial: null } }),
  ).toThrow('null');
});

it('commits validated immutable snapshots before notification and reopens them with the same owner', async () => {
  const filename = await path();
  const { ctx } = await boot(filename);
  const domain = await ctx.storage.domain.open(spec());
  const observed: DomainChanged[] = [];
  ctx.on('domain/changed', (change) => {
    observed.push(change);
    if (change.operation === 'put' && change.table === 'entries')
      expect(domain.table('entries').get(change.key)).toEqual(change.value);
  });
  const input = { count: 1 };
  const writing = domain.table('entries').put('one', input);
  input.count = 7;
  await writing;
  expect(domain.table('entries').get('one')).toEqual({ count: 1 });
  expect(() => {
    domain.table('entries').get('one')!.count = 9;
  }).toThrow();
  await domain.global.set({ title: 'Saved' });
  expect(observed).toHaveLength(2);
  await domain.close();
  const reopened = await ctx.storage.domain.open(spec());
  expect(reopened.global.get()).toEqual({ title: 'Saved' });
  expect(reopened.table('entries').get('one')).toEqual({ count: 1 });
  await expect(ctx.storage.domain.open(spec('@fixture/other'))).rejects.toMatchObject({
    code: 'already-open',
  });
  await reopened.close();
  await expect(ctx.storage.domain.open(spec('@fixture/other'))).rejects.toMatchObject({
    code: 'ownership-conflict',
  });
  const recovered = await ctx.storage.domain.open(spec());
  expect(recovered.table('entries').get('one')).toEqual({ count: 1 });
});

it('rejects malformed writes without changing memory, durable facts or notifications', async () => {
  const { ctx } = await boot();
  const domain = await ctx.storage.domain.open(spec());
  let changes = 0;
  ctx.on('domain/changed', () => {
    changes++;
  });
  await domain.table('entries').put('one', { count: 1 });
  await expect(
    Reflect.apply(domain.table('entries').put, domain.table('entries'), [
      'one',
      { count: 'private-input' },
    ]),
  ).rejects.toMatchObject({ code: 'invalid-record' });
  await expect(
    Reflect.apply(domain.global.set, domain.global, [{ title: 3 }]),
  ).rejects.toMatchObject({ code: 'invalid-record' });
  expect(changes).toBe(1);
  expect(domain.table('entries').get('one')).toEqual({ count: 1 });
  await domain.close();
  const next = await ctx.storage.domain.open(spec());
  expect(next.table('entries').get('one')).toEqual({ count: 1 });
  expect(next.global.get()).toEqual({ title: 'Initial' });
});

it('rejects an authoritative open containing an invalid stored row', async () => {
  const { ctx } = await boot();
  const descriptor = descriptorOf(spec());
  const unit = await ctx.storage.backend.get('sqlite').kv!.open(descriptor);
  await unit.putRecord('entries', 'broken', { count: 'private-stored-value' });
  await unit.close();
  let failure: unknown;
  try {
    await ctx.storage.domain.open(spec());
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'invalid-record',
    detail: { table: 'entries', key: 'broken' },
  });
  expect(String(failure)).not.toContain('private-stored-value');
  expect((failure as Error).cause).toBeUndefined();
});

it('rejects foreign database identity without applying tables or changing its header', async () => {
  const filename = await path();
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('preserved')");
  db.close();
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await expect(ctx.plugin(Sqlite, { path: filename, journalMode: 'wal' })).rejects.toMatchObject({
    code: 'malformed-medium',
  });
  const check = new DatabaseSync(filename);
  expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 0 });
  expect(check.prepare('SELECT * FROM foreign_data').get()).toMatchObject({ value: 'preserved' });
  expect(
    check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='units'").get(),
  ).toMatchObject({ count: 0 });
  check.close();
});

it('prevents competing cached record owners across backends and releases the lease on close', async () => {
  const filename = await path();
  const first = await boot(filename);
  const second = await boot(filename);
  const domain = await first.ctx.storage.domain.open(spec());
  await domain.table('entries').put('one', { count: 4 });
  await expect(second.ctx.storage.domain.open(spec())).rejects.toMatchObject({
    code: 'unit-in-use',
  });
  await domain.close();
  const reopened = await second.ctx.storage.domain.open(spec());
  expect(reopened.table('entries').get('one')).toEqual({ count: 4 });
});

it('joins in-flight opens during provider unload and rejects cached subsequent opens', async () => {
  const { ctx, provider } = await boot();
  const facet = ctx.storage.backend.get('sqlite').kv!;
  const original = facet.open.bind(facet);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.spyOn(facet, 'open').mockImplementation(async (descriptor) => {
    entered.resolve();
    await gate.promise;
    return original(descriptor);
  });
  const facility = ctx.storage.domain;
  const opening = facility.open(spec());
  const rejected = expect(opening).rejects.toMatchObject({ code: 'closed' });
  await entered.promise;
  const stopping = provider.dispose();
  await Promise.resolve();
  gate.resolve();
  await rejected;
  await stopping;
  expect(() => ctx.storage.domain).toThrow('not mounted');
  await expect(facility.open(spec())).rejects.toMatchObject({ code: 'closed' });
});

it('drains accepted writes while closing and refuses later writes', async () => {
  const { ctx } = await boot();
  const facet = ctx.storage.backend.get('sqlite').kv!;
  const open = facet.open.bind(facet);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  vi.spyOn(facet, 'open').mockImplementation(async (descriptor) => {
    const unit: KvUnit = await open(descriptor);
    const put = unit.putRecord.bind(unit);
    vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      entered.resolve();
      await gate.promise;
      return put(...args);
    });
    return unit;
  });
  const domain = await ctx.storage.domain.open(spec());
  const accepted = domain.table('entries').put('one', { count: 5 });
  await entered.promise;
  const closing = domain.close();
  await expect(domain.table('entries').put('two', { count: 8 })).rejects.toMatchObject({
    code: 'closed',
  });
  gate.resolve();
  await accepted;
  await closing;
  const reopened = await ctx.storage.domain.open(spec());
  expect(reopened.table('entries').get('one')).toEqual({ count: 5 });
  expect(reopened.table('entries').get('two')).toBeUndefined();
});

it('contains synchronous and asynchronous observer failures after durable commits', async () => {
  const { ctx } = await boot();
  const domain = await ctx.storage.domain.open(spec());
  const diagnostics = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {});
  ctx.on('domain/changed', () => {
    throw new Error('fixture-private-observer');
  });
  ctx.on('domain/changed', async () => {
    throw new Error('fixture-private-observer');
  });
  await domain.table('entries').put('one', { count: 1 });
  await Promise.resolve();
  expect(domain.table('entries').get('one')).toEqual({ count: 1 });
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('fixture-private-observer');
});
