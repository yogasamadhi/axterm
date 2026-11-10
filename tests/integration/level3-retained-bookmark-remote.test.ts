import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const homes: string[] = [],
  profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [];
afterEach(async () => {
  for (const f of profiles.splice(0).reverse()) await f.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(home?: string, application = false) {
  if (!home) {
    home = await mkdtemp(join(tmpdir(), 'axterm-bookmark-remote-'));
    homes.push(home);
  }
  const f = await remoteProfile(home, { application });
  profiles.push(f);
  return { ...f, home };
}
const failure = (reason: string) => ({ code: 'catalog/failure', details: { reason } }),
  etag = (version: number) => '"v' + version + '"';
it('replaces an explicitly confirmed same-name Host and bookmark, refusing stale confirmation without changing facts', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    initial = await remoteValue(api.getBookmarkTree());
  const first = await remoteValue(
    api.createSshBookmark(
      randomUUID(),
      {
        host: { name: 'Confirmed cloud', hostname: 'old.test', username: 'old' },
        bookmark: { title: 'Old bookmark', description: 'Clear me' },
      },
      initial.etag,
    ),
  );
  const host = await remoteValue(api.getHost(first.ids[0]!)),
    before = await remoteValue(api.getBookmarkTree()),
    bookmark = before.bookmarks.find((b) => b.id === first.ids[1])!;
  const input = {
    overwrite: { hostId: host.id, hostVersion: host.version },
    host: { name: host.name, hostname: 'new.test', port: 2200, username: 'new' },
    bookmark: { title: 'New bookmark' },
  };
  const receipt = await remoteValue(api.createSshBookmark(randomUUID(), input, before.etag)),
    updated = await remoteValue(api.getHost(host.id)),
    tree = await remoteValue(api.getBookmarkTree());
  expect(receipt.ids).toEqual([host.id, bookmark.id]);
  expect(updated).toMatchObject({ id: host.id, hostname: 'new.test', port: 2200, version: 2 });
  expect(tree.bookmarks.find((b) => b.id === bookmark.id)).toMatchObject({
    id: bookmark.id,
    title: 'New bookmark',
    description: '',
  });
  await expect(
    remoteValue(api.createSshBookmark(randomUUID(), input, tree.etag)),
  ).rejects.toMatchObject(failure('precondition-failed'));
  expect(await remoteValue(api.listHosts())).toEqual([updated]);
  expect(await remoteValue(api.getBookmarkTree())).toEqual(tree);
});
it('identifies duplicate SSH display names on create and edit while preserving both aggregates', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    initial = await remoteValue(api.getBookmarkTree());
  const input = {
    host: {
      name: 'Cloud host',
      hostname: 'localhost',
      port: 22,
      username: 'operator',
      authType: 'agent' as const,
    },
    bookmark: { title: 'Cloud host' },
  };
  const first = await remoteValue(api.createSshBookmark(randomUUID(), input, initial.etag)),
    host = await remoteValue(api.getHost(first.ids[0]!)),
    before = await remoteValue(api.getBookmarkTree());
  await expect(
    remoteValue(api.createSshBookmark(randomUUID(), input, before.etag)),
  ).rejects.toMatchObject({
    code: 'catalog/failure',
    details: { reason: 'conflict', diagnostic: { code: 'HOST_NAME_CONFLICT' } },
  });
  expect(await remoteValue(api.getBookmarkTree())).toEqual(before);
  expect(await remoteValue(api.listHosts())).toEqual([host]);
  const second = await remoteValue(
      api.createSshBookmark(
        randomUUID(),
        { ...input, host: { ...input.host, name: 'Second host' } },
        before.etag,
      ),
    ),
    secondHost = await remoteValue(api.getHost(second.ids[0]!)),
    tree = await remoteValue(api.getBookmarkTree());
  await expect(
    remoteValue(
      api.updateSshBookmark(
        randomUUID(),
        second.ids[1]!,
        { host: { name: host.name }, bookmark: { title: 'Must not change' } },
        etag(secondHost.version),
        tree.etag,
      ),
    ),
  ).rejects.toMatchObject({
    code: 'catalog/failure',
    details: { reason: 'conflict', diagnostic: { code: 'HOST_NAME_CONFLICT' } },
  });
  expect(await remoteValue(api.getBookmarkTree())).toEqual(tree);
  expect(await remoteValue(api.getHost(secondHost.id))).toEqual(secondHost);
});
it('returns only original safe SSH field paths and operation identity without writing invalid input or secret values', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    tree = await remoteValue(api.getBookmarkTree()),
    key = randomUUID();
  const error: unknown = await remoteValue(
    api.createSshBookmark(
      key,
      {
        host: {
          name: 'Validation fixture',
          hostname: 'localhost',
          username: 'operator',
          port: 70_000,
          authType: 'password',
          startup: { environment: { 'invalid secret-value': 'secret-value' } },
        },
        bookmark: { title: 'Validation fixture' },
      },
      tree.etag,
    ),
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 'catalog/failure',
    details: {
      reason: 'invalid-input',
      diagnostic: {
        code: 'VALIDATION_ERROR',
        operationId: key,
        fields: expect.arrayContaining(['host.port', 'host.startup']),
      },
    },
  });
  expect(JSON.stringify(error)).not.toContain('secret-value');
  expect(key).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await remoteValue(api.listHosts())).toEqual([]);
});
it('enforces both aggregate preconditions for atomic SSH creation and Host deletion without orphan writes', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    initial = await remoteValue(api.getBookmarkTree());
  const input = {
    host: {
      name: 'atomic-gateway',
      hostname: 'gateway.example.test',
      port: 2202,
      username: 'operator',
      authType: 'agent' as const,
      credentialRef: null,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: true,
    },
    bookmark: {
      groupId: null,
      title: 'Atomic Gateway',
      color: null,
      description: '',
      profileId: null,
    },
  };
  await expect(
    remoteValue(api.createSshBookmark(randomUUID(), input, undefined)),
  ).rejects.toMatchObject(failure('precondition-required'));
  const created = await remoteValue(api.createSshBookmark(randomUUID(), input, initial.etag)),
    host = await remoteValue(api.getHost(created.ids[0]!)),
    tree = await remoteValue(api.getBookmarkTree());
  expect(tree.bookmarks[0]?.hostId).toBe(host.id);
  expect(created.version).toBe(host.version);
  expect(created.treeRevision).toBe(tree.revision);
  await expect(
    remoteValue(
      api.createSshBookmark(
        randomUUID(),
        { ...input, host: { ...input.host, name: 'orphan-candidate' } },
        initial.etag,
      ),
    ),
  ).rejects.toMatchObject(failure('precondition-failed'));
  expect(await remoteValue(api.listHosts())).toEqual([host]);
  for (const [hostVersion, treeVersion, reason] of [
    [undefined, tree.etag, 'precondition-required'],
    [etag(host.version), undefined, 'precondition-required'],
    [etag(host.version), initial.etag, 'precondition-failed'],
    ['"v99"', tree.etag, 'precondition-failed'],
  ] as const)
    await expect(
      remoteValue(api.deleteSshBookmarkHost(randomUUID(), host.id, hostVersion, treeVersion)),
    ).rejects.toMatchObject(failure(reason));
  const deleted = await remoteValue(
    api.deleteSshBookmarkHost(randomUUID(), host.id, etag(host.version), tree.etag),
  );
  expect(deleted.ids).toEqual([host.id, created.ids[1]]);
  expect(deleted.deletedCount).toBe(1);
  const after = await remoteValue(api.getBookmarkTree());
  expect(after.revision).toBe(tree.revision + 1);
  expect(after.bookmarks).toEqual([]);
  expect(await remoteValue(api.listHosts())).toEqual([]);
});
it('updates one SSH row with complete placement and shared Host retention before deleting the last bookmark', async () => {
  const f = await fixture(undefined, true),
    api = f.client.remote.catalog;
  let tree = await remoteValue(api.getBookmarkTree());
  await remoteValue(api.createBookmarkGroup(randomUUID(), { name: 'Source' }, tree.etag));
  tree = await remoteValue(api.getBookmarkTree());
  await remoteValue(api.createBookmarkGroup(randomUUID(), { name: 'Destination' }, tree.etag));
  tree = await remoteValue(api.getBookmarkTree());
  const source = tree.groups.find((g) => g.name === 'Source')!,
    destination = tree.groups.find((g) => g.name === 'Destination')!;
  const saved = await remoteValue(
      api.createSshBookmark(
        randomUUID(),
        {
          host: {
            name: 'row-target',
            hostname: 'old.example.test',
            port: 22,
            username: 'operator',
            authType: 'agent',
          },
          bookmark: { groupId: source.id, title: 'Row target' },
        },
        tree.etag,
      ),
    ),
    host = await remoteValue(api.getHost(saved.ids[0]!));
  tree = await remoteValue(api.getBookmarkTree());
  const shared = await remoteValue(
    api.createBookmark(
      randomUUID(),
      { protocol: 'ssh', hostId: host.id, groupId: source.id, title: 'Shared target' },
      tree.etag,
    ),
  );
  tree = await remoteValue(api.getBookmarkTree());
  await remoteValue(
    api.updateSshBookmark(
      randomUUID(),
      saved.ids[1]!,
      {
        host: { hostname: 'new.example.test', port: 2202, username: 'deploy' },
        bookmark: {
          groupId: destination.id,
          title: 'Updated row target',
          color: '#aabbcc',
          description: 'Updated from the protocol form',
        },
      },
      etag(host.version),
      tree.etag,
    ),
  );
  const updatedTree = await remoteValue(api.getBookmarkTree()),
    updatedHost = await remoteValue(api.getHost(host.id));
  expect(updatedTree.revision).toBe(tree.revision + 1);
  expect(updatedHost).toMatchObject({
    hostname: 'new.example.test',
    port: 2202,
    username: 'deploy',
    version: host.version + 1,
  });
  expect(updatedTree.bookmarks.find((b) => b.id === saved.ids[1])).toMatchObject({
    groupId: destination.id,
    title: 'Updated row target',
    color: '#aabbcc',
    connectionDisplay: 'deploy@new.example.test:2202',
    position: 0,
  });
  expect(
    updatedTree.bookmarks
      .filter((b) => b.groupId === source.id)
      .map(({ id, position }) => ({ id, position })),
  ).toEqual([{ id: shared.ids[0], position: 0 }]);
  const retained = await remoteValue(
    api.deleteSshBookmark(randomUUID(), saved.ids[1]!, etag(updatedHost.version), updatedTree.etag),
  );
  expect(retained.ids).toEqual([saved.ids[1]]);
  expect(await remoteValue(api.getHost(host.id))).toEqual(updatedHost);
  const remaining = await remoteValue(api.getBookmarkTree());
  expect(remaining.bookmarks.map((b) => b.id)).toEqual([shared.ids[0]]);
  const removed = await remoteValue(
    api.deleteSshBookmark(randomUUID(), shared.ids[0]!, etag(updatedHost.version), remaining.etag),
  );
  expect(removed.ids).toEqual([shared.ids[0], host.id]);
  expect((await remoteValue(api.getBookmarkTree())).bookmarks).toEqual([]);
  expect(await remoteValue(api.listHosts())).toEqual([]);
});
it('persists the original nested bookmark tree across actual Profile restart and refuses missing stale and descendant moves', async () => {
  let f = await fixture(),
    api = f.client.remote.catalog;
  const empty = await remoteValue(api.getBookmarkTree());
  expect(empty.etag).toBe('"bookmark-tree-v1"');
  await expect(
    remoteValue(api.createBookmarkGroup(randomUUID(), { name: 'Missing precondition' }, undefined)),
  ).rejects.toMatchObject(failure('precondition-required'));
  const rootReceipt = await remoteValue(
    api.createBookmarkGroup(
      randomUUID(),
      { name: 'Production', color: '#2fc7a1', description: 'Production systems' },
      empty.etag,
    ),
  );
  let tree = await remoteValue(api.getBookmarkTree());
  const root = tree.groups.find((g) => g.id === rootReceipt.ids[0])!;
  const childReceipt = await remoteValue(
    api.createBookmarkGroup(randomUUID(), { parentId: root.id, name: 'Asia' }, tree.etag),
  );
  tree = await remoteValue(api.getBookmarkTree());
  const saved = await remoteValue(
    api.createSshBookmark(
      randomUUID(),
      {
        host: {
          name: 'gateway',
          hostname: 'gateway.example.test',
          port: 2202,
          username: 'operator',
          authType: 'agent',
          credentialRef: null,
          passphraseCredentialRef: null,
          jumpHostId: null,
          favorite: true,
        },
        bookmark: {
          groupId: childReceipt.ids[0]!,
          title: 'Gateway',
          description: 'Primary bastion',
        },
      },
      tree.etag,
    ),
  );
  const complete = await remoteValue(api.getBookmarkTree());
  await expect(
    remoteValue(api.createBookmarkGroup(randomUUID(), { name: 'stale' }, empty.etag)),
  ).rejects.toMatchObject(failure('precondition-failed'));
  await expect(
    remoteValue(
      api.moveBookmarkTreeNode(
        randomUUID(),
        {
          source: { kind: 'group', id: root.id },
          target: { kind: 'group', id: childReceipt.ids[0]! },
          position: 'inside',
        },
        complete.etag,
      ),
    ),
  ).rejects.toMatchObject(failure('conflict'));
  expect(complete.bookmarks[0]).toMatchObject({
    hostId: saved.ids[0],
    connectionDisplay: 'operator@gateway.example.test:2202',
  });
  await f.close();
  f = await fixture(f.home);
  api = f.client.remote.catalog;
  expect(await remoteValue(api.getBookmarkTree())).toEqual(complete);
});
