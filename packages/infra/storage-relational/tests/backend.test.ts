import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  StorageMigrationConnection,
  StorageMigrationStatement,
} from '@axterm/plugin-api/host';
import { afterEach, expect, it, vi } from 'vitest';
import {
  defineDomain,
  storageBackendServiceKey,
  type RelationalDomainSpec,
  type StorageOutboxEvent,
} from '@axterm/plugin-api';
import Storage from '@axterm/infra-storage';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function file() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-relational-'));
  roots.push(root);
  return join(root, 'facts.sqlite');
}
function spec(name: string): RelationalDomainSpec {
  return defineDomain({
    kind: 'relational',
    name,
    owner: `@fixture/${name}`,
    version: 1,
    tables: [name + '_items'],
    migrations: [
      { version: 1, sql: `CREATE TABLE ${name}_items(id TEXT PRIMARY KEY,value TEXT NOT NULL)` },
    ],
  });
}
async function boot(path = ':memory:', routes: Record<string, string> = {}) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  const backend = ctx.plugin(Relational, { path });
  await backend;
  if (Object.values(routes).includes('other')) {
    const other = new Relational.RelationalStorageBackend(':memory:');
    ctx.effect(() => () => other.close());
    await other.initialize();
    ctx.storage.backend.register('other', other);
    ctx.provide(storageBackendServiceKey('other'), other);
  }
  await ctx.plugin(Domains, { backend: 'relational', routes });
  return { ctx, backend, sql: ctx.storage.backend.get('relational').sql! };
}

it('permits owned statements and rejects cross-domain reads, writes, schema changes and attachment', async () => {
  const { ctx } = await boot();
  const a = await ctx.storage.domain.open(spec('alpha'));
  const b = await ctx.storage.domain.open(spec('beta'));
  a.run('INSERT INTO alpha_items VALUES (?,?)', 'one', 'owned');
  b.run('INSERT INTO beta_items VALUES (?,?)', 'two', 'preserved');
  expect(a.get('SELECT * FROM alpha_items')).toEqual({ id: 'one', value: 'owned' });
  for (const sql of [
    "UPDATE beta_items SET value='wrong'",
    'SELECT * FROM beta_items',
    'DROP TABLE alpha_items',
    "ATTACH ':memory:' AS escape",
    'PRAGMA writable_schema=ON',
  ])
    expect(() => a.run(sql)).toThrow();
  expect(b.get('SELECT * FROM beta_items')).toEqual({ id: 'two', value: 'preserved' });
  await expect(
    ctx.storage.domain.open({ ...spec('other'), tables: ['alpha_items'] }),
  ).rejects.toMatchObject({ code: 'ownership-conflict' });
  await a.close();
  expect(() => a.get('SELECT * FROM alpha_items')).toThrow('closed');
});

it('commits participant facts and outbox together, and publishes after the outer transaction', async () => {
  const { ctx, sql } = await boot();
  const a = await ctx.storage.domain.open(spec('alpha'));
  const b = await ctx.storage.domain.open(spec('beta'));
  const observed: StorageOutboxEvent[] = [];
  sql.subscribe((events) => {
    expect(a.all('SELECT * FROM alpha_items')).toHaveLength(1);
    expect(b.all('SELECT * FROM beta_items')).toHaveLength(1);
    observed.push(...events);
  });
  sql.transaction([a.participant, b.participant], () => {
    a.run('INSERT INTO alpha_items VALUES (?,?)', 'a', 'first');
    a.appendEvent('alpha/created', { id: 'a' });
    b.transaction(() => {
      b.run('INSERT INTO beta_items VALUES (?,?)', 'b', 'second');
      b.appendEvent('beta/created', { id: 'b' });
    });
    expect(observed).toHaveLength(0);
  });
  expect(observed.map((event) => event.domain)).toEqual(['alpha', 'beta']);
  expect(sql.events(0)).toEqual(observed);
  expect(() => a.transaction(() => b.run("UPDATE beta_items SET value='outside'"))).toThrow(
    'not admitted',
  );
});

it('routes the public domain transaction to one medium and rejects foreign, closed or cross-medium participants', async () => {
  const { ctx } = await boot(':memory:', { gamma: 'other' });
  const a = await ctx.storage.domain.open(spec('alpha'));
  const b = await ctx.storage.domain.open(spec('beta'));
  const observed = vi.fn();
  a.subscribe(observed);
  expect(() =>
    ctx.storage.domain.transaction([a.participant, b.participant], () => {
      a.run("INSERT INTO alpha_items VALUES ('a','rollback')");
      a.appendEvent('alpha/changed', { id: 'a' });
      b.run("INSERT INTO beta_items VALUES ('b','rollback')");
      throw new Error('abort transaction');
    }),
  ).toThrow('abort transaction');
  expect(a.all('SELECT * FROM alpha_items')).toEqual([]);
  expect(b.all('SELECT * FROM beta_items')).toEqual([]);
  expect(a.cursor()).toBe(0);
  expect(observed).not.toHaveBeenCalled();
  ctx.storage.domain.transaction([a.participant, b.participant], () => {
    a.run("INSERT INTO alpha_items VALUES ('a','committed')");
    a.appendEvent('alpha/changed', { id: 'a' });
    b.run("INSERT INTO beta_items VALUES ('b','committed')");
    expect(observed).not.toHaveBeenCalled();
  });
  expect(observed).toHaveBeenCalledOnce();
  const callback = vi.fn();
  expect(() => ctx.storage.domain.transaction([{} as typeof a.participant], callback)).toThrow(
    'participants',
  );
  expect(callback).not.toHaveBeenCalled();
  const c = await ctx.storage.domain.open(spec('gamma'));
  // Both are valid routed handles, but distributed transactions are not fabricated.
  expect(() => ctx.storage.domain.transaction([a.participant, c.participant], callback)).toThrow(
    'participants',
  );
  await a.close();
  expect(() => ctx.storage.domain.transaction([a.participant, b.participant], callback)).toThrow(
    'participants',
  );
});

it('exposes only owned persisted cursors/events, observes another Profile commit, and revokes cached observers', async () => {
  const path = await file();
  const first = await boot(path);
  const second = await boot(path);
  const a = await first.ctx.storage.domain.open(spec('alpha'));
  const b = await first.ctx.storage.domain.open(spec('beta'));
  const remote = await second.ctx.storage.domain.open(spec('alpha'));
  const local = vi.fn();
  const crossProfile = vi.fn();
  a.subscribe(local);
  remote.subscribe(crossProfile);
  a.appendEvent('alpha/changed', { id: 'one' });
  b.appendEvent('beta/changed', { id: 'private-other-domain' });
  expect(local).toHaveBeenCalledOnce();
  expect(crossProfile).not.toHaveBeenCalled();
  expect(remote.cursor()).toBe(a.cursor());
  expect(remote.events(0)).toEqual([
    { cursor: a.cursor(), domain: 'alpha', type: 'alpha/changed', payload: { id: 'one' } },
  ]);
  expect(JSON.stringify(remote.events(0))).not.toContain('private-other-domain');
  local.mock.calls[0]![0][0].payload.id = 'mutated observer copy';
  expect(a.events(0)[0]!.payload).toEqual({ id: 'one' });
  expect(() => a.events(-1)).toThrow('range');
  expect(() => a.events(0, 10_001)).toThrow('range');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const unregister = a.subscribe(async () => {
      throw new Error('private observer failure');
    });
    a.appendEvent('alpha/changed', { id: 'two' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[storage] Commit observer failed'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private observer failure');
    unregister();
    const cursor = a.cursor();
    await a.close();
    expect(() => a.cursor()).toThrow('closed');
    expect(() => a.events(cursor)).toThrow('closed');
    expect(() => a.subscribe(() => {})).toThrow('closed');
    const count = local.mock.calls.length;
    remote.appendEvent('alpha/changed', { id: 'after-close' });
    expect(local).toHaveBeenCalledTimes(count);
    expect(remote.events(cursor)).toMatchObject([{ payload: { id: 'after-close' } }]);
  } finally {
    warn.mockRestore();
  }
});

it('rolls back facts and outbox on failure and removes only a failed nested savepoint', async () => {
  const { ctx, sql } = await boot();
  const a = await ctx.storage.domain.open(spec('alpha'));
  const notify = vi.fn();
  sql.subscribe(notify);
  expect(() =>
    a.transaction(() => {
      a.run("INSERT INTO alpha_items VALUES ('x','rollback')");
      a.appendEvent('alpha/created', {});
      throw new Error('failed');
    }),
  ).toThrow('failed');
  expect(a.all('SELECT * FROM alpha_items')).toEqual([]);
  expect(sql.events(0)).toEqual([]);
  expect(notify).not.toHaveBeenCalled();
  a.transaction(() => {
    a.run("INSERT INTO alpha_items VALUES ('one','retained')");
    expect(() =>
      a.transaction(() => {
        a.run("INSERT INTO alpha_items VALUES ('two','rollback')");
        a.appendEvent('alpha/failed', {});
        throw new Error('nested');
      }),
    ).toThrow('nested');
    a.appendEvent('alpha/created', { id: 'one' });
  });
  expect(a.all('SELECT id FROM alpha_items')).toEqual([{ id: 'one' }]);
  expect(sql.events(0)).toHaveLength(1);
  expect(notify).toHaveBeenCalledOnce();
});

it('rejects asynchronous transaction callbacks and prevents escaped continuations from mutating facts', async () => {
  const { ctx } = await boot();
  const a = await ctx.storage.domain.open(spec('alpha'));
  const gate = Promise.withResolvers<void>();
  let continuation: Promise<void> | undefined;
  expect(() =>
    a.transaction(() => {
      continuation = (async () => {
        a.run("INSERT INTO alpha_items VALUES ('before','rollback')");
        await gate.promise;
        a.run("INSERT INTO alpha_items VALUES ('after','forbidden')");
      })();
      return continuation;
    }),
  ).toThrow('synchronous');
  gate.resolve();
  await expect(continuation).rejects.toThrow('scope has ended');
  expect(a.all('SELECT * FROM alpha_items')).toEqual([]);
  a.transaction(() => a.run("INSERT INTO alpha_items VALUES ('valid','accepted')"));
  expect(a.all('SELECT id FROM alpha_items')).toEqual([{ id: 'valid' }]);
});

it('contains commit observer failures and persists cursors across reopen', async () => {
  const path = await file();
  const { ctx, sql } = await boot(path);
  const a = await ctx.storage.domain.open(spec('alpha'));
  const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
  sql.subscribe(() => {
    throw new Error('private-observer-value');
  });
  a.transaction(() => {
    a.run("INSERT INTO alpha_items VALUES ('one','saved')");
    a.appendEvent('alpha/created', { id: 'one' });
  });
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-observer-value');
  const cursor = sql.events(0)[0]!.cursor;
  await ctx.fiber.dispose();
  const reopened = await boot(path);
  const domain = await reopened.ctx.storage.domain.open(spec('alpha'));
  expect(domain.all('SELECT * FROM alpha_items')).toEqual([{ id: 'one', value: 'saved' }]);
  const next = domain.appendEvent('alpha/updated', { id: 'one' });
  expect(next).toBeGreaterThan(cursor);
  expect(reopened.sql.events(cursor)).toHaveLength(1);
});

it('validates immutable forward migrations, rejects downgrade and detects another Profile upgrade', async () => {
  const path = await file();
  const first = await boot(path);
  const a = await first.ctx.storage.domain.open(spec('alpha'));
  a.run("INSERT INTO alpha_items VALUES ('one','preserved')");
  const upgraded = {
    ...spec('alpha'),
    version: 2,
    migrations: [
      ...spec('alpha').migrations,
      { version: 2, sql: 'ALTER TABLE alpha_items ADD COLUMN extra TEXT' },
    ],
  };
  const second = await boot(path);
  const b = await second.ctx.storage.domain.open(upgraded);
  expect(b.get('SELECT value,extra FROM alpha_items')).toEqual({ value: 'preserved', extra: null });
  expect(() => a.run("UPDATE alpha_items SET value='stale'")).toThrow('schema changed');
  await a.close();
  await b.close();
  await expect(second.ctx.storage.domain.open(spec('alpha'))).rejects.toMatchObject({
    code: 'version-mismatch',
  });
  await expect(
    second.ctx.storage.domain.open({
      ...upgraded,
      migrations: [
        { version: 1, sql: 'CREATE TABLE alpha_items(wrong TEXT)' },
        upgraded.migrations[1]!,
      ],
    }),
  ).rejects.toMatchObject({ code: 'version-mismatch' });
  const restored = await second.ctx.storage.domain.open(upgraded);
  expect(restored.get('SELECT value FROM alpha_items')).toEqual({ value: 'preserved' });
});

it('rejects cross-owner writes originating in an existing SQL trigger', async () => {
  const path = await file();
  const { ctx } = await boot(path);
  const a = await ctx.storage.domain.open(spec('alpha'));
  const b = await ctx.storage.domain.open(spec('beta'));
  const fixture = new DatabaseSync(path);
  fixture.exec(
    'CREATE TRIGGER unsafe_forward AFTER INSERT ON alpha_items BEGIN INSERT INTO beta_items VALUES(new.id,new.value); END',
  );
  fixture.close();
  expect(() => a.run("INSERT INTO alpha_items VALUES ('one','forbidden')")).toThrow();
  expect(a.all('SELECT * FROM alpha_items')).toEqual([]);
  expect(b.all('SELECT * FROM beta_items')).toEqual([]);
});

it('revokes cached handles and transaction participants when the backend unloads', async () => {
  const { ctx, backend, sql } = await boot();
  const domain = await ctx.storage.domain.open(spec('alpha'));
  await backend.dispose();
  expect(ctx.storage.backend.names()).toEqual([]);
  expect(() => domain.run('DELETE FROM alpha_items')).toThrow('not available');
  expect(() => sql.transaction([domain.participant], () => {})).toThrow('not available');
  await expect(sql.open(spec('beta'))).rejects.toThrow('not available');
});

it('revokes migration ports and prepared wrappers after the synchronous bootstrap scope', async () => {
  let retained: StorageMigrationConnection | undefined;
  let prepared: StorageMigrationStatement | undefined;
  const sql =
    "CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_meta VALUES ('axterm:schema-generation','2')";
  const backend = new Relational.RelationalStorageBackend(':memory:', {
    generation: 2,
    tables: [],
    migrations: [
      {
        id: 1,
        risky: false,
        sql,
        apply: (port) => {
          port.exec(sql);
          retained = port;
          prepared = port.prepare('SELECT count(*) AS count FROM app_meta');
          expect(prepared.get()).toEqual({ count: 1 });
        },
      },
    ],
  });
  try {
    await backend.initialize();
    expect(retained).not.toHaveProperty('close');
    expect(prepared).not.toHaveProperty('iterate');
    expect(() => retained!.exec('DELETE FROM app_meta')).toThrow('scope has ended');
    expect(() => prepared!.get()).toThrow('scope has ended');
  } finally {
    await backend.close();
  }
});
