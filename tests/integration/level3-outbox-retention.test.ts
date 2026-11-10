import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { productDomains } from '@axterm/data-schema';
import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { configurationFixture } from '../fixtures/level3-configuration.ts';
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
it('retains the original10000 event ceiling and monotonic cursors per owner across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-outbox-retained-'));
  directories.push(directory);
  const path = join(directory, 'facts.sqlite');
  let f = await ownedStorage(path),
    catalog = await f.open(productDomains.catalog);
  catalog.transaction(() => {
    for (let index = 0; index < 10005; index++)
      catalog.appendEvent('retention.tested', { aggregateId: String(index), payload: { index } });
  });
  expect(catalog.cursor()).toBe(10005);
  expect(catalog.events(5, 10000)).toHaveLength(10000);
  expect(catalog.events(5, 1)[0]).toMatchObject({
    cursor: 6,
    payload: { aggregateId: '5', payload: { index: 5 } },
  });
  expect(catalog.events(4, 10000)).toEqual([]);
  const configuration = await f.open(productDomains.configuration);
  configuration.appendEvent('configuration/test', { value: 'other-owner' });
  expect(catalog.cursor()).toBe(10005);
  expect(catalog.events(5, 10000)).toHaveLength(10000);
  expect(() => catalog.get('SELECT * FROM axterm_storage_outbox_bounds')).toThrow();
  await f.close();
  f = await ownedStorage(path);
  catalog = await f.open(productDomains.catalog);
  expect(catalog.cursor()).toBe(10005);
  expect(catalog.events(4)).toEqual([]);
  expect(catalog.events(5, 1)[0]?.cursor).toBe(6);
  const next = catalog.appendEvent('retention.tested', { index: 10005 });
  expect(next).toBe(10007);
  expect(catalog.events(5)).toEqual([]);
  expect(catalog.events(6, 10000)).toHaveLength(10000);
});
it('rolls back pruning and its recovery boundary with a failed fact transaction', async () => {
  const f = await ownedStorage(),
    domain = await f.open(productDomains.catalog);
  domain.transaction(() => {
    for (let i = 0; i < 10000; i++) domain.appendEvent('retention.tested', { index: i });
  });
  expect(() =>
    domain.transaction(() => {
      domain.run(
        "INSERT INTO host_groups(id,name,created_at,updated_at) VALUES (?,'Rolled back','now','now')",
        randomUUID(),
      );
      domain.appendEvent('host-group.created', {});
      throw Error('OUTER_ROLLBACK');
    }),
  ).toThrow('OUTER_ROLLBACK');
  expect(domain.events(0, 10000)).toHaveLength(10000);
  expect(domain.cursor()).toBe(10000);
  expect(domain.all('SELECT * FROM host_groups')).toEqual([]);
});
it('recovers all actual Catalog collections when the consumer cursor predates pruned events', async () => {
  const f = await configurationFixture(),
    domain = f.handles.get('catalog')!,
    abort = new AbortController();
  const stream = f.ctx.catalogController.watchCatalog(abort.signal)[Symbol.asyncIterator]();
  async function batch() {
    const updates = [];
    while (true) {
      const next = await stream.next();
      if (next.done) throw Error('STREAM_ENDED');
      updates.push(next.value);
      if (next.value.type === 'commit') return updates;
    }
  }
  try {
    const baseline = await batch();
    expect(baseline[0]).toMatchObject({ type: 'begin', mode: 'baseline' });
    f.ctx.catalogController.createHost(randomUUID(), {
      name: 'Recovered actual Host',
      hostname: 'recovery.example.test',
      username: 'operator',
    });
    domain.transaction(() => {
      for (let i = 0; i < 10000; i++)
        domain.appendEvent('connection-profile.updated', { index: i });
    });
    const delta = await batch();
    expect(delta[0]).toMatchObject({
      type: 'begin',
      collections: ['hosts', 'hostGroups', 'bookmarks', 'connectionProfiles', 'history'],
    });
    expect(JSON.stringify(delta)).toContain('Recovered actual Host');
  } finally {
    abort.abort();
    await stream.return?.();
  }
});
