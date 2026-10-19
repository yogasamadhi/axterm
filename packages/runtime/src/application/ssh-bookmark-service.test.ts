import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ConnectionHistoryRepository } from '../adapters/sqlite/connection-history-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { etagFor, ProductRepository } from '../adapters/sqlite/product-repository';
import { BookmarkTreeService } from './bookmark-tree-service';
import { SshBookmarkService } from './ssh-bookmark-service';

async function fixture() {
  const database = await ProductDatabase.open();
  const hosts = new ProductRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const service = new SshBookmarkService(database, hosts, bookmarks);
  return { database, hosts, bookmarks, service };
}

function input(name: string, groupId: string | null = null) {
  return {
    host: {
      name,
      hostname: `${name}.example.test`,
      port: 22,
      username: 'operator',
      authType: 'privateKey' as const,
      credentialRef: `cred_${randomUUID()}`,
      passphraseCredentialRef: null,
      jumpHostId: null,
      favorite: false,
    },
    bookmark: {
      groupId,
      title: `${name} bookmark`,
      color: '#2fc7a1',
      description: 'Saved SSH destination',
      profileId: null,
    },
  };
}

describe('SshBookmarkService', () => {
  it('replaces a confirmed same-name destination with complete new values and keeps shared references', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    const history = new ConnectionHistoryRepository(database);
    try {
      const first = service.create(input('overwrite-cloud'), bookmarks.snapshot().etag);
      const old = hosts.updateHost(
        first.host.id,
        {
          favorite: true,
          certificateCredentialRef: `cred_${randomUUID()}`,
          startup: { directory: '/old', environment: { OLD: 'value' } },
          x11: { enabled: true, display: ':99' },
          sshAgent: { enabled: true, path: '/old-agent' },
          proxy: { mode: 'command', command: { executable: 'old-proxy', arguments: ['%h', '%p'] } },
        },
        etagFor(first.host.version),
      );
      const snapshot = history.record({ host: old, persistedHostId: old.id });
      const sharedTree = bookmarks.createBookmark(
        { protocol: 'ssh', hostId: old.id, title: 'Independent shared bookmark' },
        first.tree.etag,
      );
      const shared = sharedTree.bookmarks.find(
        ({ title }) => title === 'Independent shared bookmark',
      )!;
      const jump = hosts.createHost({
        name: 'Uses overwritten jump',
        hostname: 'jump-user.test',
        username: 'user',
        jumpHostIds: [old.id],
      });
      const result = service.create(
        {
          overwrite: { hostId: old.id, hostVersion: old.version },
          host: { name: old.name, hostname: 'new.example.test', port: 2022, username: 'new-user' },
          bookmark: { title: 'New bookmark' },
        },
        sharedTree.etag,
      );
      expect(result.host).toMatchObject({
        id: old.id,
        createdAt: old.createdAt,
        version: old.version + 1,
        hostname: 'new.example.test',
        port: 2022,
        username: 'new-user',
        authType: 'password',
        credentialRef: null,
        passphraseCredentialRef: null,
        certificateCredentialRef: null,
        favorite: false,
        jumpHostId: null,
        jumpHostIds: [],
        proxy: { mode: 'inherit' },
        startup: { directory: null, environment: {}, loginScripts: [], runScripts: [] },
        x11: { enabled: false, display: null },
        sshAgent: { enabled: true, path: null },
      });
      expect(result.bookmark).toMatchObject({
        id: first.bookmark.id,
        title: 'New bookmark',
        color: null,
        description: '',
        profileId: null,
        connectionProfileId: null,
        quickCommands: [],
        triggers: [],
      });
      expect(result.tree.bookmarks.find(({ id }) => id === shared.id)).toEqual({
        ...shared,
        connectionDisplay: 'new-user@new.example.test:2022',
      });
      expect(hosts.getHost(jump.id).jumpHostIds).toEqual([old.id]);
      expect(history.get(snapshot.id)).toEqual(snapshot);
      expect(hosts.listHosts()).toHaveLength(2);
      expect(result.tree.bookmarks).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('overwrites a retained Host without a Bookmark and creates its new tree entry', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      const old = hosts.createHost({ name: 'Orphan cloud', hostname: 'old.test', username: 'old' });
      const result = service.create(
        {
          overwrite: { hostId: old.id, hostVersion: old.version },
          host: { name: old.name, hostname: 'new.test', username: 'new' },
          bookmark: { title: old.name },
        },
        bookmarks.snapshot().etag,
      );
      expect(result.host).toMatchObject({ id: old.id, version: 2, hostname: 'new.test' });
      expect(result.bookmark.hostId).toBe(old.id);
      expect(hosts.listHosts()).toHaveLength(1);
      expect(result.tree.bookmarks).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each(['host', 'tree', 'name'] as const)(
    'rejects a stale %s overwrite without durable writes',
    async (stale) => {
      const { database, hosts, bookmarks, service } = await fixture();
      try {
        const old = service.create(input('Stale overwrite'), bookmarks.snapshot().etag);
        if (stale === 'host')
          hosts.updateHost(old.host.id, { hostname: 'concurrent.test' }, etagFor(old.host.version));
        if (stale === 'tree') bookmarks.createGroup({ name: 'Concurrent group' }, old.tree.etag);
        const before = hosts.getHost(old.host.id);
        const tree = bookmarks.snapshot();
        const events = hosts.listEvents();
        expect(() =>
          service.create(
            {
              ...input(stale === 'name' ? 'Wrong name' : old.host.name),
              overwrite: { hostId: old.host.id, hostVersion: old.host.version },
            },
            old.tree.etag,
          ),
        ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
        expect(hosts.getHost(old.host.id)).toEqual(before);
        expect(bookmarks.snapshot()).toEqual(tree);
        expect(hosts.listEvents()).toEqual(events);
      } finally {
        database.close();
      }
    },
  );

  it.each(['update', 'insert'] as const)(
    'rolls confirmed overwrite back on a late Bookmark %s failure',
    async (write) => {
      const { database, hosts, bookmarks, service } = await fixture();
      try {
        const old =
          write === 'update'
            ? service.create(input('Rollback overwrite'), bookmarks.snapshot().etag).host
            : hosts.createHost(input('Rollback overwrite').host);
        const before = bookmarks.snapshot();
        const events = hosts.listEvents();
        database.run(`CREATE TRIGGER fail_overwrite BEFORE ${write.toUpperCase()} ON bookmarks
        BEGIN SELECT RAISE(ABORT, 'forced bookmark failure'); END`);
        expect(() =>
          service.create(
            {
              ...input(old.name),
              overwrite: { hostId: old.id, hostVersion: old.version },
            },
            before.etag,
          ),
        ).toThrow();
        expect(hosts.getHost(old.id)).toEqual(old);
        expect(bookmarks.snapshot()).toEqual(before);
        expect(hosts.listEvents()).toEqual(events);
      } finally {
        database.close();
      }
    },
  );

  it.each(['bookmark', 'host'] as const)(
    'releases a deleted %s name while preserving independently versioned history',
    async (mode) => {
      const { database, hosts, bookmarks, service } = await fixture();
      const history = new ConnectionHistoryRepository(database);
      try {
        const saved = service.create(input('deleted-cloud'), bookmarks.snapshot().etag);
        history.record({ host: saved.host, persistedHostId: saved.host.id });
        const item = history.record({ host: saved.host, persistedHostId: saved.host.id });
        const before = history.state();
        const tree =
          mode === 'bookmark'
            ? service.deleteBookmark(
                saved.bookmark.id,
                etagFor(saved.host.version),
                saved.tree.etag,
              ).tree
            : service.delete(saved.host.id, etagFor(saved.host.version), saved.tree.etag).tree;
        expect(hosts.listHosts()).toEqual([]);
        expect(tree.bookmarks).toEqual([]);
        expect(history.get(item.id)).toMatchObject({
          ...item,
          hostId: null,
          updatedAt: expect.any(String),
          version: item.version + 1,
          count: 2,
        });
        expect(history.state().revision).toBe(before.revision + 1);
        expect(() => history.assertVersion(item.id, etagFor(item.version))).toThrowError(
          expect.objectContaining({ code: 'PRECONDITION_FAILED' }),
        );
        expect(
          hosts.listEvents().filter(({ type }) => type === 'connection-history.unlinked'),
        ).toHaveLength(1);
        const replacement = input('deleted-cloud');
        const recreated = service.create(
          { ...replacement, host: { ...replacement.host, hostname: 'new.example.test' } },
          tree.etag,
        );
        expect(recreated.host.id).not.toBe(saved.host.id);
        expect(recreated.host.name).toBe(saved.host.name);
        expect(history.get(item.id).hostname).toBe(saved.host.hostname);
        expect(history.get(item.id).hostId).toBeNull();
      } finally {
        database.close();
      }
    },
  );

  it('rolls detached history, its revision and events back if Host deletion fails', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    const history = new ConnectionHistoryRepository(database);
    try {
      const saved = service.create(input('retained-on-failure'), bookmarks.snapshot().etag);
      const item = history.record({ host: saved.host, persistedHostId: saved.host.id });
      const state = history.state();
      const events = hosts.listEvents();
      database.run(`CREATE TRIGGER fail_history_host_delete BEFORE DELETE ON hosts
        BEGIN SELECT RAISE(ABORT, 'forced deletion failure'); END`);
      expect(() =>
        service.deleteBookmark(saved.bookmark.id, etagFor(saved.host.version), saved.tree.etag),
      ).toThrow();
      expect(history.get(item.id)).toEqual(item);
      expect(history.state()).toEqual(state);
      expect(bookmarks.snapshot()).toEqual(saved.tree);
      expect(hosts.getHost(saved.host.id)).toEqual(saved.host);
      expect(hosts.listEvents()).toEqual(events);
    } finally {
      database.close();
    }
  });

  it('retains a real historical jump dependency during single-row deletion', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    const history = new ConnectionHistoryRepository(database);
    try {
      const saved = service.create(input('historical-jump'), bookmarks.snapshot().etag);
      const item = history.record({
        host: { ...saved.host, hostname: 'behind-jump.example.test', jumpHostId: saved.host.id },
        persistedHostId: null,
      });
      const deleted = service.deleteBookmark(
        saved.bookmark.id,
        etagFor(saved.host.version),
        saved.tree.etag,
      );
      expect(deleted).toMatchObject({ hostDeleted: false, retainedBy: ['history'] });
      expect(hosts.getHost(saved.host.id)).toEqual(saved.host);
      expect(history.get(item.id).jumpHostId).toBe(saved.host.id);
      service.delete(saved.host.id, etagFor(saved.host.version), deleted.tree.etag);
      expect(hosts.listHosts()).toEqual([]);
      expect(history.get(item.id)).toMatchObject({
        hostId: null,
        jumpHostId: null,
        version: item.version + 1,
      });
    } finally {
      database.close();
    }
  });

  it('atomically creates a Host fact and its Bookmark without writing legacy placement', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      let tree = bookmarks.snapshot();
      tree = bookmarks.createGroup({ name: 'Production' }, tree.etag);
      const group = tree.groups[0]!;
      const beforeEvents = hosts.listEvents().length;

      const result = service.create(input('gateway', group.id), tree.etag);

      expect(result.host).toMatchObject({
        groupId: null,
        name: 'gateway',
        hostname: 'gateway.example.test',
      });
      expect(result.tree.revision).toBe(tree.revision + 1);
      expect(result.tree.bookmarks).toEqual([
        expect.objectContaining({
          groupId: group.id,
          protocol: 'ssh',
          hostId: result.host.id,
          title: 'gateway bookmark',
          connectionDisplay: 'operator@gateway.example.test:22',
        }),
      ]);
      expect(result.bookmark.id).toBe(result.tree.bookmarks[0]!.id);
      expect(hosts.listHostGroups()).toEqual([]);
      expect(
        hosts
          .listEvents()
          .slice(beforeEvents)
          .map(({ type }) => type),
      ).toEqual(['host.created', 'bookmark.created']);
      expect(JSON.stringify(hosts.listEvents())).not.toContain('PRIVATE KEY');
    } finally {
      database.close();
    }
  });

  it('rolls back the Host, tree revision and events when Bookmark creation fails', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      const before = bookmarks.snapshot();
      const beforeEvents = hosts.listEvents();
      expect(() => service.create(input('orphan', randomUUID()), before.etag)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(before);
      expect(hosts.listEvents()).toEqual(beforeEvents);

      let current = bookmarks.createGroup({ name: 'Changed elsewhere' }, before.etag);
      expect(() => service.create(input('stale'), before.etag)).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }),
      );
      expect(hosts.listHosts()).toEqual([]);
      expect(bookmarks.snapshot()).toEqual(current);
      current = service.create(input('valid'), current.etag).tree;
      expect(hosts.listHosts()).toHaveLength(1);
      expect(current.bookmarks).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('updates Host facts and Bookmark metadata across groups in one tree revision', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      let tree = bookmarks.snapshot();
      tree = bookmarks.createGroup({ name: 'Source' }, tree.etag);
      tree = bookmarks.createGroup({ name: 'Destination' }, tree.etag);
      const source = tree.groups.find(({ name }) => name === 'Source')!;
      const destination = tree.groups.find(({ name }) => name === 'Destination')!;
      const jump = service.create(input('jump', destination.id), tree.etag);
      const saved = service.create(input('target', source.id), jump.tree.etag);
      const peer = service.create(input('peer', source.id), saved.tree.etag);
      tree = peer.tree;
      const profileId = randomUUID();
      const eventCount = hosts.listEvents().length;

      const updated = service.updateBookmark(
        saved.bookmark.id,
        {
          host: {
            name: 'updated target',
            hostname: 'updated.example.test',
            port: 2222,
            username: 'deploy',
            authType: 'agent',
            credentialRef: null,
            passphraseCredentialRef: null,
            jumpHostId: jump.host.id,
            favorite: true,
            connectionOptions: {
              connectionTimeoutMs: 28_000,
              keepaliveIntervalMs: 4_000,
              keepaliveCountMax: 6,
              compression: false,
              reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 4 },
            },
          },
          bookmark: {
            groupId: destination.id,
            title: 'Updated target bookmark',
            color: '#aabbcc',
            description: 'Moved atomically',
            profileId,
          },
        },
        etagFor(saved.host.version),
        tree.etag,
      );

      expect(updated.host).toMatchObject({
        id: saved.host.id,
        groupId: null,
        name: 'updated target',
        hostname: 'updated.example.test',
        port: 2222,
        username: 'deploy',
        authType: 'agent',
        jumpHostId: jump.host.id,
        favorite: true,
        connectionOptions: {
          connectionTimeoutMs: 28_000,
          keepaliveIntervalMs: 4_000,
          keepaliveCountMax: 6,
          compression: false,
          reconnectPolicy: { mode: 'automatic', delayMs: 750, maxAttempts: 4 },
        },
        version: saved.host.version + 1,
      });
      expect(updated.bookmark).toMatchObject({
        id: saved.bookmark.id,
        groupId: destination.id,
        title: 'Updated target bookmark',
        color: '#aabbcc',
        description: 'Moved atomically',
        profileId,
        position: 1,
        connectionDisplay: 'deploy@updated.example.test:2222',
      });
      expect(updated.tree.revision).toBe(tree.revision + 1);
      expect(
        updated.tree.bookmarks
          .filter(({ groupId }) => groupId === source.id)
          .map(({ id, position }) => ({ id, position })),
      ).toEqual([{ id: peer.bookmark.id, position: 0 }]);
      expect(
        updated.tree.bookmarks
          .filter(({ groupId }) => groupId === destination.id)
          .map(({ id, position }) => ({ id, position })),
      ).toEqual([
        { id: jump.bookmark.id, position: 0 },
        { id: saved.bookmark.id, position: 1 },
      ]);
      expect(
        hosts
          .listEvents()
          .slice(eventCount)
          .map(({ type }) => type),
      ).toEqual(['host.updated', 'bookmark.updated']);

      const beforeRejected = {
        tree: bookmarks.snapshot(),
        hosts: hosts.listHosts(),
        events: hosts.listEvents(),
      };
      expect(() =>
        service.updateBookmark(
          saved.bookmark.id,
          { host: { favorite: false }, bookmark: {} },
          etagFor(saved.host.version),
          updated.tree.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }));
      expect(() =>
        service.updateBookmark(
          saved.bookmark.id,
          { host: { favorite: false }, bookmark: {} },
          etagFor(updated.host.version),
          tree.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }));
      expect(() =>
        service.updateBookmark(
          saved.bookmark.id,
          {
            host: { name: 'must roll back' },
            bookmark: { groupId: randomUUID() },
          },
          etagFor(updated.host.version),
          updated.tree.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND', status: 404 }));
      expect(() =>
        service.updateBookmark(
          jump.bookmark.id,
          { host: { jumpHostId: saved.host.id }, bookmark: { title: 'cycle' } },
          etagFor(jump.host.version),
          updated.tree.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT', status: 409 }));
      expect(bookmarks.snapshot()).toEqual(beforeRejected.tree);
      expect(hosts.listHosts()).toEqual(beforeRejected.hosts);
      expect(hosts.listEvents()).toEqual(beforeRejected.events);

      database.run(`CREATE TRIGGER fail_atomic_bookmark_update
        BEFORE UPDATE ON bookmarks WHEN OLD.id='${saved.bookmark.id}'
        BEGIN SELECT RAISE(ABORT, 'forced bookmark update failure'); END`);
      expect(() =>
        service.updateBookmark(
          saved.bookmark.id,
          { host: { name: 'rolled back host' }, bookmark: { title: 'will fail' } },
          etagFor(updated.host.version),
          updated.tree.etag,
        ),
      ).toThrow();
      expect(bookmarks.snapshot()).toEqual(beforeRejected.tree);
      expect(hosts.listHosts()).toEqual(beforeRejected.hosts);
      expect(hosts.listEvents()).toEqual(beforeRejected.events);
    } finally {
      database.close();
    }
  });

  it('deletes one SSH Bookmark and retains or removes its Host by authoritative references', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      const first = service.create(input('shared'), bookmarks.snapshot().etag);
      const tree = bookmarks.createBookmark(
        {
          protocol: 'ssh',
          hostId: first.host.id,
          title: 'Second view of shared Host',
        },
        first.tree.etag,
      );
      const secondBookmark = tree.bookmarks.find(
        ({ id, hostId }) => hostId === first.host.id && id !== first.bookmark.id,
      )!;

      const sharedDelete = service.deleteBookmark(
        first.bookmark.id,
        etagFor(first.host.version),
        tree.etag,
      );
      expect(sharedDelete).toMatchObject({
        bookmarkId: first.bookmark.id,
        hostId: first.host.id,
        hostDeleted: false,
        remainingBookmarkIds: [secondBookmark.id],
        retainedBy: ['bookmark'],
      });
      expect(sharedDelete.tree.revision).toBe(tree.revision + 1);
      expect(hosts.getHost(first.host.id)).toEqual(first.host);

      const target = service.create(input('jump-target'), sharedDelete.tree.etag);
      const dependentInput = input('jump-dependent');
      const dependent = service.create(
        { ...dependentInput, host: { ...dependentInput.host, jumpHostId: target.host.id } },
        target.tree.etag,
      );
      const jumpRetained = service.deleteBookmark(
        target.bookmark.id,
        etagFor(target.host.version),
        dependent.tree.etag,
      );
      expect(jumpRetained).toMatchObject({
        hostDeleted: false,
        remainingBookmarkIds: [],
        retainedBy: ['jumpHost'],
      });
      expect(hosts.getHost(target.host.id)).toEqual(target.host);
      expect(hosts.getHost(dependent.host.id).jumpHostId).toBe(target.host.id);

      const last = service.create(input('last-reference'), jumpRetained.tree.etag);
      const removed = service.deleteBookmark(
        last.bookmark.id,
        etagFor(last.host.version),
        last.tree.etag,
      );
      expect(removed).toMatchObject({
        bookmarkId: last.bookmark.id,
        hostId: last.host.id,
        hostDeleted: true,
        remainingBookmarkIds: [],
        retainedBy: [],
      });
      expect(removed.tree.revision).toBe(last.tree.revision + 1);
      expect(() => hosts.getHost(last.host.id)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
      );
    } finally {
      database.close();
    }
  });

  it('rolls back single-Bookmark deletion when final Host cleanup fails', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      const saved = service.create(input('delete-rollback'), bookmarks.snapshot().etag);
      const beforeEvents = hosts.listEvents();
      database.run(`CREATE TRIGGER fail_final_host_delete
        BEFORE DELETE ON hosts WHEN OLD.id='${saved.host.id}'
        BEGIN SELECT RAISE(ABORT, 'forced final host delete failure'); END`);

      expect(() =>
        service.deleteBookmark(saved.bookmark.id, etagFor(saved.host.version), saved.tree.etag),
      ).toThrow();
      expect(bookmarks.snapshot()).toEqual(saved.tree);
      expect(hosts.getHost(saved.host.id)).toEqual(saved.host);
      expect(hosts.listEvents()).toEqual(beforeEvents);
    } finally {
      database.close();
    }
  });

  it('deletes every Bookmark for a Host and the Host in one revision while preserving order', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      let tree = bookmarks.snapshot();
      tree = bookmarks.createGroup({ name: 'Production' }, tree.etag);
      const group = tree.groups[0]!;
      const saved = service.create(input('gateway', group.id), tree.etag);
      tree = saved.tree;
      tree = bookmarks.createGroup({ name: 'Staging' }, tree.etag);
      const secondGroup = tree.groups.find(({ name }) => name === 'Staging')!;
      tree = bookmarks.createBookmark(
        {
          groupId: secondGroup.id,
          protocol: 'ssh',
          hostId: saved.host.id,
          title: 'gateway duplicate',
        },
        tree.etag,
      );
      const peer = service.create(input('peer', group.id), tree.etag);
      tree = peer.tree;
      const beforeDelete = tree;

      const changedHost = hosts.updateHost(
        saved.host.id,
        { favorite: true },
        etagFor(saved.host.version),
      );
      expect(() =>
        service.delete(saved.host.id, etagFor(changedHost.version), saved.tree.etag),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }));
      expect(bookmarks.snapshot()).toEqual(beforeDelete);
      expect(() =>
        service.delete(saved.host.id, etagFor(saved.host.version), tree.etag),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }));
      expect(bookmarks.snapshot()).toEqual(beforeDelete);

      expect(() => hosts.deleteHost(saved.host.id, etagFor(changedHost.version))).toThrowError(
        expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      );
      database.run(`CREATE TRIGGER fail_saved_host_delete
        BEFORE DELETE ON hosts WHEN OLD.id='${saved.host.id}'
        BEGIN SELECT RAISE(ABORT, 'forced host delete failure'); END`);
      const eventCount = hosts.listEvents().length;
      expect(() =>
        service.delete(saved.host.id, etagFor(changedHost.version), tree.etag),
      ).toThrow();
      expect(bookmarks.snapshot()).toEqual(beforeDelete);
      expect(hosts.getHost(saved.host.id)).toEqual(changedHost);
      expect(hosts.listEvents()).toHaveLength(eventCount);
      database.run('DROP TRIGGER fail_saved_host_delete');

      const deleted = service.delete(saved.host.id, etagFor(changedHost.version), tree.etag);
      expect(deleted.hostId).toBe(saved.host.id);
      expect(deleted.bookmarkIds).toHaveLength(2);
      expect(deleted.tree.revision).toBe(tree.revision + 1);
      expect(deleted.tree.bookmarks).toEqual([
        expect.objectContaining({ hostId: peer.host.id, position: 0 }),
      ]);
      expect(() => hosts.getHost(saved.host.id)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
      expect(hosts.getHost(peer.host.id)).toBeDefined();

      const deletionEvents = hosts
        .listEvents()
        .filter(
          ({ type, aggregateId }) =>
            type === 'bookmark.bulk-deleted' ||
            (type === 'host.deleted' && aggregateId === saved.host.id),
        );
      expect(deletionEvents.map(({ type }) => type)).toEqual([
        'bookmark.bulk-deleted',
        'host.deleted',
      ]);
      expect(deletionEvents[0]?.payload).toMatchObject({
        bookmarkIds: expect.arrayContaining(deleted.bookmarkIds),
        treeRevision: deleted.tree.revision,
      });
    } finally {
      database.close();
    }
  });

  it('deletes an orphan Host without changing the independent tree revision', async () => {
    const { database, hosts, bookmarks, service } = await fixture();
    try {
      const orphan = hosts.createHost({
        groupId: null,
        name: 'orphan',
        hostname: 'orphan.example.test',
        port: 22,
        username: 'operator',
        authType: 'agent',
        credentialRef: null,
        passphraseCredentialRef: null,
        jumpHostId: null,
        favorite: false,
      });
      const before = bookmarks.snapshot();
      const result = service.delete(orphan.id, etagFor(orphan.version), before.etag);
      expect(result.bookmarkIds).toEqual([]);
      expect(result.tree).toEqual(before);
      expect(() => hosts.getHost(orphan.id)).toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
    } finally {
      database.close();
    }
  });
});
