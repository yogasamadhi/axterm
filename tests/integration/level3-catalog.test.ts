import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import type { CatalogBaseline, CatalogUpdate } from '@axterm/plugin-api/catalog';
import { createHostSchema, hostSchema } from '@axterm/plugin-api/catalog';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { ConnectionHistoryRepository } from '../../packages/plugins/catalog/src/adapters/connection-history-repository.ts';
import { BookmarkTreeService } from '../../packages/plugins/catalog/src/application/bookmark-tree-service.ts';
import { CatalogProjection } from '../../packages/plugins/catalog/src/client/projection.ts';

const contexts: Context[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function boot(path = ':memory:') {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path, schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const facility = ctx.storage.domain;
  const open = facility.open.bind(facility);
  let facts: RelationalDomain | undefined;
  vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
    const handle = await open(spec);
    // Vitest reflects the last overload; the runtime branch is the relational Catalog spec.
    if (spec.name === 'catalog' && 'participant' in handle)
      facts = handle as unknown as RelationalDomain;
    return handle;
  });
  const owner = ctx.plugin(Catalog);
  await owner;
  const connections = await ctx.storage.domain.open(Schema.productDomains.connections);
  return { ctx, owner, controller: ctx.catalogController, facts: facts!, connections };
}
const destination = (name: string) => ({
  host: { name, hostname: 'fixture.example', username: 'operator' },
  bookmark: { title: name },
});

it('commits SSH Host and Bookmark facts with one durable receipt and replays retries without new events', async () => {
  const { controller, facts } = await boot();
  const key = randomUUID();
  const input = destination('SSH destination');
  const observed = vi.fn(() => {
    expect(controller.listHosts()).toHaveLength(1);
    expect(controller.getBookmarkTree().bookmarks).toHaveLength(1);
  });
  facts.subscribe(observed);
  const etag = controller.getBookmarkTree().etag;
  const receipt = controller.createSshBookmark(key, input, etag);
  const cursor = facts.cursor();
  expect(receipt.ids).toHaveLength(2);
  expect(receipt.cursor).toBe(cursor);
  const replay = controller.createSshBookmark(key, input, etag);
  expect(replay).toEqual(receipt);
  expect(facts.cursor()).toBe(cursor);
  expect(controller.listHosts()).toHaveLength(1);
  expect(controller.getBookmarkTree().bookmarks[0]?.hostId).toBe(receipt.ids[0]);
  expect(observed).toHaveBeenCalled();
});

it('rolls back Host, tree, outbox and receipt together on a stale tree, then allows the same key to retry', async () => {
  const { controller, facts } = await boot();
  const stale = controller.getBookmarkTree().etag;
  controller.createBookmarkGroup(randomUUID(), { name: 'Group' }, stale);
  const cursor = facts.cursor();
  const key = randomUUID();
  expect(() => controller.createSshBookmark(key, destination('Retry'), stale)).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'precondition-failed' }),
    }),
  );
  expect(controller.listHosts()).toEqual([]);
  expect(facts.cursor()).toBe(cursor);
  expect(
    facts.get('SELECT command_id FROM axterm_catalog_command_receipts WHERE command_id=?', key),
  ).toBeUndefined();
  controller.createSshBookmark(key, destination('Retry'), controller.getBookmarkTree().etag);
  expect(controller.listHosts()).toHaveLength(1);
});

it('retains a saved Host referenced by another owner and rolls back deletion when that owner is missing', async () => {
  const { ctx, controller, facts, connections } = await boot();
  const receipt = controller.createSshBookmark(
    randomUUID(),
    destination('Retained'),
    controller.getBookmarkTree().etag,
  );
  const [hostId, bookmarkId] = receipt.ids as [string, string];
  const before = controller.getBookmarkTree();
  const cursor = facts.cursor();
  expect(() =>
    controller.deleteSshBookmark(randomUUID(), bookmarkId, '"v1"', before.etag),
  ).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'unavailable' }) }),
  );
  expect(controller.getBookmarkTree()).toEqual(before);
  expect(facts.cursor()).toBe(cursor);
  const release = ctx.catalogReferences.register('@axterm/plugin-connections', {
    participant: connections.participant,
    retainedBy: () => ['tunnel'],
  });
  controller.deleteSshBookmark(randomUUID(), bookmarkId, '"v1"', before.etag);
  expect(controller.getBookmarkTree().bookmarks).toEqual([]);
  expect(controller.getHost(hostId).id).toBe(hostId);
  await release();
});

it('deletes an unreferenced SSH Host and Bookmark together and rejects changed idempotency payloads', async () => {
  const { ctx, controller, connections } = await boot();
  ctx.catalogReferences.register('@axterm/plugin-connections', {
    participant: connections.participant,
    retainedBy: () => [],
  });
  const key = randomUUID();
  const receipt = controller.createSshBookmark(
    key,
    destination('Delete'),
    controller.getBookmarkTree().etag,
  );
  expect(() => controller.createSshBookmark(key, destination('Changed'), '"tree-1"')).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'conflict' }) }),
  );
  controller.deleteSshBookmark(
    randomUUID(),
    receipt.ids[1]!,
    '"v1"',
    controller.getBookmarkTree().etag,
  );
  expect(controller.listHosts()).toEqual([]);
  expect(controller.getBookmarkTree().bookmarks).toEqual([]);
});

it('validates secret-free profile DTOs and rejects stale updates and unloaded controller handles', async () => {
  const { controller, owner } = await boot();
  const receipt = controller.createConnectionProfile(randomUUID(), {
    name: 'Profile',
    ssh: { username: 'operator', passwordCredentialRef: 'vault:opaque' },
  });
  const id = receipt.ids[0]!;
  expect(controller.getConnectionProfile(id).ssh.passwordCredentialRef).toBe('vault:opaque');
  controller.updateConnectionProfile(randomUUID(), id, { name: 'Updated' }, '"v1"');
  expect(() =>
    controller.updateConnectionProfile(randomUUID(), id, { name: 'Stale' }, '"v1"'),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'precondition-failed' }),
    }),
  );
  expect(() =>
    controller.createConnectionProfile(randomUUID(), {
      name: 'Plaintext',
      ssh: { password: 'fixture-secret' },
    } as never),
  ).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'invalid-input' }) }),
  );
  await owner.dispose();
  expect(() => controller.listHosts()).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'closed' }) }),
  );
});

async function readCommit(
  iterator: AsyncIterator<CatalogUpdate>,
  projection: CatalogProjection,
): Promise<CatalogBaseline> {
  for (let count = 0; count < 10_000; count++) {
    const frame = await iterator.next();
    expect(frame.done).toBe(false);
    const baseline = projection.accept(frame.value!);
    if (baseline) return baseline;
  }
  throw new Error('Fixture did not reach an atomic catalog commit');
}

it('publishes a complete baseline and atomic replacement deltas, including multi-frame Unicode bookmarks', async () => {
  const { controller, facts, ctx } = await boot();
  const abort = new AbortController();
  const iterator = controller.watchCatalog(abort.signal)[Symbol.asyncIterator]();
  const projection = new CatalogProjection();
  const initial = await readCommit(iterator, projection);
  expect(initial.hosts).toEqual([]);
  expect(initial.generation).toBe(ctx.runtimeIdentity.generation);
  const input = {
    protocol: 'local' as const,
    hostId: null,
    title: '界面',
    quickCommands: Array.from({ length: 4 }, (_, index) => ({
      name: `Command ${index}`,
      command: '界😀'.repeat(4_000),
    })),
  };
  controller.createBookmark(randomUUID(), input, initial.bookmarks.etag);
  const updated = await readCommit(iterator, projection);
  expect(updated.bookmarks.bookmarks[0]?.quickCommands).toEqual(input.quickCommands);
  expect(updated.cursor).toBe(facts.cursor());
  expect(updated.hosts).toBe(initial.hosts);
  expect(Object.isFrozen(updated.bookmarks.bookmarks[0]?.quickCommands)).toBe(true);
  const pending = iterator.next();
  abort.abort();
  expect((await pending).done).toBe(true);
  expect((await iterator.next()).done).toBe(true);
});

it('bounds never-read watches, releases them on abort, and retires paused transfers on unload', async () => {
  const { controller, owner } = await boot();
  const abort = new AbortController();
  const watches = Array.from({ length: 64 }, () =>
    controller.watchCatalog(abort.signal)[Symbol.asyncIterator](),
  );
  expect(() => controller.watchCatalog(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'capacity' }) }),
  );
  abort.abort();
  for (const watch of watches) expect((await watch.next()).done).toBe(true);
  const paused = controller.watchCatalog(new AbortController().signal)[Symbol.asyncIterator]();
  expect((await paused.next()).value.type).toBe('begin');
  await owner.dispose();
  expect((await paused.next()).done).toBe(true);
});

it('observes another Profile through persisted cursors and replaces the baseline after reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-catalog-profile-'));
  directories.push(directory);
  const first = await boot(join(directory, 'facts.sqlite'));
  const second = await boot(join(directory, 'facts.sqlite'));
  const abort = new AbortController();
  const iterator = first.controller.watchCatalog(abort.signal)[Symbol.asyncIterator]();
  const projection = new CatalogProjection();
  const initial = await readCommit(iterator, projection);
  const pending = readCommit(iterator, projection);
  second.controller.createHostGroup(randomUUID(), { name: 'Other Profile' });
  const updated = await pending;
  expect(updated.hostGroups[0]?.name).toBe('Other Profile');
  expect(updated.cursor).toBeGreaterThan(initial.cursor);
  expect(updated.generation).toBe(first.ctx.runtimeIdentity.generation);
  abort.abort();
  const reconnect = second.controller
    .watchCatalog(new AbortController().signal)
    [Symbol.asyncIterator]();
  projection.reset();
  const replaced = await readCommit(reconnect, projection);
  expect(replaced.hostGroups).toEqual(updated.hostGroups);
  expect(replaced.generation).toBe(second.ctx.runtimeIdentity.generation);
  await reconnect.return?.();
});

it('updates Host membership when a group deletion performs the owned foreign-key action', async () => {
  const { controller } = await boot();
  const group = controller.createHostGroup(randomUUID(), { name: 'Group' });
  controller.createHost(randomUUID(), {
    name: 'Grouped',
    hostname: 'fixture.example',
    username: 'operator',
    groupId: group.ids[0]!,
  });
  const iterator = controller.watchCatalog(new AbortController().signal)[Symbol.asyncIterator]();
  const projection = new CatalogProjection();
  const initial = await readCommit(iterator, projection);
  expect(initial.hosts[0]?.groupId).toBe(group.ids[0]);
  controller.deleteHostGroup(randomUUID(), group.ids[0]!, '"v1"');
  const updated = await readCommit(iterator, projection);
  expect(updated.hostGroups).toEqual([]);
  expect(updated.hosts[0]?.groupId).toBeNull();
  await iterator.return?.();
});

it('withdraws a reference projection when its caller unloads and refuses cached registrations after provider unload', async () => {
  const { ctx, controller, owner, connections } = await boot();
  const caller = ctx.plugin({ inject: ['catalogReferences'], apply() {} });
  await caller;
  const registry = caller.ctx.catalogReferences;
  const source = {
    participant: connections.participant,
    retainedBy: (): readonly 'tunnel'[] => ['tunnel'],
  };
  registry.register('@axterm/plugin-connections', source);
  // Replacing a registered object property cannot swap the captured owner projection.
  source.retainedBy = () => [];
  const first = controller.createSshBookmark(
    randomUUID(),
    destination('Retained owner'),
    controller.getBookmarkTree().etag,
  );
  controller.deleteSshBookmark(
    randomUUID(),
    first.ids[1]!,
    '"v1"',
    controller.getBookmarkTree().etag,
  );
  expect(controller.getHost(first.ids[0]!).id).toBe(first.ids[0]);
  const next = controller.createSshBookmark(
    randomUUID(),
    destination('Missing owner'),
    controller.getBookmarkTree().etag,
  );
  const draining = Promise.withResolvers<void>();
  caller.ctx.effect(() => () => draining.promise);
  const unloading = caller.dispose();
  expect(() =>
    controller.deleteSshBookmark(
      randomUUID(),
      next.ids[1]!,
      '"v1"',
      controller.getBookmarkTree().etag,
    ),
  ).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ reason: 'unavailable' }) }),
  );
  expect(controller.getBookmark(next.ids[1]!).id).toBe(next.ids[1]);
  draining.resolve();
  await unloading;
  await owner.dispose();
  expect(() => registry.register('@fixture/late', source)).toThrow();
});

it('releases an opened domain when the Catalog caller unloads during asynchronous activation', async () => {
  const { ctx, owner } = await boot();
  await owner.dispose();
  const facility = ctx.storage.domain;
  const original = vi.mocked(facility.open).getMockImplementation()!;
  const opened = Promise.withResolvers<RelationalDomain>();
  const resume = Promise.withResolvers<void>();
  vi.mocked(facility.open).mockImplementationOnce(async (spec) => {
    const handle = await original(spec);
    opened.resolve(handle as unknown as RelationalDomain);
    await resume.promise;
    return handle;
  });
  const replacement = ctx.plugin(Catalog);
  const activation = Promise.resolve(replacement).catch(() => {});
  const domain = await opened.promise;
  const closing = replacement.dispose();
  resume.resolve();
  await closing;
  await activation;
  expect(() => domain.get('SELECT id FROM hosts')).toThrow('closed');
  const reopened = await facility.open(Schema.productDomains.catalog);
  expect(reopened.all('SELECT id FROM hosts')).toEqual([]);
  await reopened.close();
});

it('selects changed collections and the baseline cursor from one SQLite snapshot across Profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-catalog-snapshot-race-'));
  directories.push(directory);
  const first = await boot(join(directory, 'facts.sqlite'));
  const second = await boot(join(directory, 'facts.sqlite'));
  const iterator = first.controller
    .watchCatalog(new AbortController().signal)
    [Symbol.asyncIterator]();
  const projection = new CatalogProjection();
  await readCommit(iterator, projection);
  first.controller.createBookmarkGroup(
    randomUUID(),
    { name: 'First change' },
    first.controller.getBookmarkTree().etag,
  );
  const transaction = first.facts.transaction.bind(first.facts);
  vi.spyOn(first.facts, 'transaction').mockImplementationOnce((apply) => {
    second.controller.createHostGroup(randomUUID(), { name: 'Before snapshot' });
    return transaction(apply);
  });
  const replacement = await readCommit(iterator, projection);
  expect(replacement.hostGroups.some(({ name }) => name === 'Before snapshot')).toBe(true);
  expect(replacement.bookmarks.groups.some(({ name }) => name === 'First change')).toBe(true);
  expect(replacement.cursor).toBe(first.facts.cursor());
  await iterator.return?.();
});

function historyFixture(facts: RelationalDomain, name = 'Recent destination') {
  const history = new ConnectionHistoryRepository(new CatalogStorage(facts));
  const now = new Date().toISOString();
  const host = hostSchema.parse({
    ...createHostSchema.parse({ name, hostname: 'history.example', username: 'operator' }),
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const item = history.record({ host, persistedHostId: null });
  return { history, item, host };
}
it('atomically promotes a transient history target and replays its compact receipt after later fact changes', async () => {
  const f = await boot();
  const { history, item } = historyFixture(f.facts);
  const key = randomUUID();
  const tree = f.controller.getBookmarkTree();
  const etag = `"v${item.version}"`;
  const receipt = f.controller.promoteConnectionHistoryToBookmark(
    key,
    item.id,
    { title: 'Saved recent target' },
    etag,
    tree.etag,
  );
  expect(receipt.createdHost).toBe(true);
  expect(receipt.ids).toEqual([item.id, receipt.hostId, receipt.bookmarkId]);
  expect(f.controller.getHost(receipt.hostId)).toMatchObject({
    hostname: item.hostname,
    credentialRef: null,
  });
  expect(f.controller.getBookmark(receipt.bookmarkId)).toMatchObject({
    title: 'Saved recent target',
    hostId: receipt.hostId,
  });
  expect(history.get(item.id)).toMatchObject({ hostId: receipt.hostId, version: item.version + 1 });
  f.controller.updateHost(
    randomUUID(),
    receipt.hostId,
    { name: 'Renamed authoritative target' },
    '"v1"',
  );
  const cursor = f.facts.cursor();
  expect(
    f.controller.promoteConnectionHistoryToBookmark(
      key,
      item.id,
      { title: 'Saved recent target' },
      etag,
      tree.etag,
    ),
  ).toEqual(receipt);
  expect(f.facts.cursor()).toBe(cursor);
  expect(f.controller.listHosts()).toHaveLength(1);
});
it('keeps history promotion atomic on stale preconditions and a late Bookmark failure, then retries the uncommitted key', async () => {
  const f = await boot();
  const { history, item } = historyFixture(f.facts);
  const key = randomUUID();
  const tree = f.controller.getBookmarkTree();
  expect(() =>
    f.controller.promoteConnectionHistoryToBookmark(key, item.id, {}, '"v999"', tree.etag),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'precondition-failed' }),
    }),
  );
  f.controller.createBookmarkGroup(randomUUID(), { name: 'Concurrent group' }, tree.etag);
  expect(() =>
    f.controller.promoteConnectionHistoryToBookmark(key, item.id, {}, '"v1"', tree.etag),
  ).toThrowError(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'precondition-failed' }),
    }),
  );
  const current = f.controller.getBookmarkTree();
  const cursor = f.facts.cursor();
  const fail = vi
    .spyOn(BookmarkTreeService.prototype, 'createBookmark')
    .mockImplementationOnce(() => {
      throw new Error('LATE_BOOKMARK_FAILURE');
    });
  expect(() =>
    f.controller.promoteConnectionHistoryToBookmark(key, item.id, {}, '"v1"', current.etag),
  ).toThrow('The catalog operation failed');
  expect(f.controller.listHosts()).toEqual([]);
  expect(history.get(item.id)).toEqual(item);
  expect(f.facts.cursor()).toBe(cursor);
  expect(f.controller.getBookmarkTree()).toEqual(current);
  fail.mockRestore();
  expect(
    f.controller.promoteConnectionHistoryToBookmark(key, item.id, {}, '"v1"', current.etag)
      .createdHost,
  ).toBe(true);
});
it('reuses compatible current Hosts and keeps name-collision suffixes within the retained display limit', async () => {
  const f = await boot();
  const existing = f.controller.createHost(randomUUID(), {
    name: 'Compatible saved target',
    hostname: 'HISTORY.EXAMPLE.',
    username: 'operator',
  });
  const { history, item } = historyFixture(f.facts);
  const receipt = f.controller.promoteConnectionHistoryToBookmark(
    randomUUID(),
    item.id,
    {},
    '"v1"',
    f.controller.getBookmarkTree().etag,
  );
  expect(receipt.createdHost).toBe(false);
  expect(receipt.hostId).toBe(existing.ids[0]);
  expect(history.get(item.id).hostId).toBe(existing.ids[0]);
  const long = 'x'.repeat(100);
  f.controller.createHost(randomUUID(), {
    name: long,
    hostname: 'different.example',
    username: 'operator',
  });
  const other = historyFixture(f.facts, long); // Same target is already compatible, so use a different port.
  const otherHost = { ...other.host, port: 2222 };
  const fresh = history.record({ host: otherHost, persistedHostId: null });
  const unique = f.controller.promoteConnectionHistoryToBookmark(
    randomUUID(),
    fresh.id,
    {},
    `"v${fresh.version}"`,
    f.controller.getBookmarkTree().etag,
  );
  expect(unique.createdHost).toBe(true);
  expect(f.controller.getHost(unique.hostId).name).toBe('x'.repeat(96) + ' (2)');
});

it('atomically updates protocol settings and placement with one receipt, rolling back a missing group or stale tree', async () => {
  const { controller, facts } = await boot();
  const group = controller.createBookmarkGroup(
    randomUUID(),
    { name: 'Destination' },
    controller.getBookmarkTree().etag,
  ).ids[0]!;
  const bookmark = controller.createBookmark(
    randomUUID(),
    { protocol: 'web', hostId: null, title: 'Original', web: { url: 'https://example.test/' } },
    controller.getBookmarkTree().etag,
  ).ids[0]!;
  const before = controller.getBookmarkTree(),
    cursor = facts.cursor(),
    key = randomUUID();
  expect(() =>
    controller.updateBookmark(
      key,
      bookmark,
      {
        groupId: randomUUID(),
        title: 'Must roll back',
        web: { url: 'https://example.test/new', userAgent: null, hideAddressBar: false },
      },
      before.etag,
    ),
  ).toThrow();
  expect(controller.getBookmarkTree()).toEqual(before);
  expect(facts.cursor()).toBe(cursor);
  const input = {
    groupId: group,
    title: 'Updated',
    web: { url: 'https://example.test/new', userAgent: null, hideAddressBar: true },
  };
  const receipt = controller.updateBookmark(key, bookmark, input, before.etag);
  expect(
    controller.getBookmarkTree().bookmarks.find((value) => value.id === bookmark),
  ).toMatchObject({ groupId: group, title: 'Updated', web: input.web });
  const committed = facts.cursor();
  expect(controller.updateBookmark(key, bookmark, input, before.etag)).toEqual(receipt);
  expect(facts.cursor()).toBe(committed);
  expect(() =>
    controller.updateBookmark(
      randomUUID(),
      bookmark,
      { groupId: null, title: 'Stale' },
      before.etag,
    ),
  ).toThrow();
  expect(facts.cursor()).toBe(committed);
});
