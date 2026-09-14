import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import type { BookmarkTreeNodeRef, BookmarkTreeSnapshot } from '../domain/bookmarks/model';
import { BookmarkTreeService } from './bookmark-tree-service';

async function fixture() {
  const database = await ProductDatabase.open();
  const products = new ProductRepository(database);
  const host = products.createHost({
    groupId: null,
    name: `host-${randomUUID()}`,
    hostname: '127.0.0.1',
    port: 22,
    username: 'operator',
    authType: 'password',
    credentialRef: 'cred_reference_only',
    passphraseCredentialRef: null,
    jumpHostId: null,
    favorite: false,
  });
  const bookmarks = new BookmarkRepository(database);
  return { database, products, host, service: new BookmarkTreeService(bookmarks) };
}

function groupRef(id: string): BookmarkTreeNodeRef {
  return { kind: 'group', id };
}

function bookmarkRef(id: string): BookmarkTreeNodeRef {
  return { kind: 'bookmark', id };
}

function childOrder(snapshot: BookmarkTreeSnapshot, parentId: string | null): string[] {
  return [
    ...snapshot.groups
      .filter((group) => group.parentId === parentId)
      .map((group) => ({ id: `group:${group.id}`, position: group.position })),
    ...snapshot.bookmarks
      .filter((bookmark) => bookmark.groupId === parentId)
      .map((bookmark) => ({ id: `bookmark:${bookmark.id}`, position: bookmark.position })),
  ]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

describe('BookmarkTreeService', () => {
  it('creates a nested ordered tree and rejects stale tree ETags', async () => {
    const { database, host, service } = await fixture();
    try {
      const initial = service.snapshot();
      const withRoot = service.createGroup({ name: 'Production' }, initial.etag);
      const root = withRoot.groups.find((group) => group.name === 'Production')!;
      const withChild = service.createGroup(
        { parentId: root.id, name: 'Asia', color: '#0088CC', description: 'Primary region' },
        withRoot.etag,
      );
      const child = withChild.groups.find((group) => group.name === 'Asia')!;
      const withBookmark = service.createBookmark(
        {
          groupId: child.id,
          protocol: 'ssh',
          hostId: host.id,
          title: 'Gateway',
          description: 'Production bastion',
          quickCommands: [{ name: 'Health check', command: 'echo BOOKMARK_COMMAND_NOT_AN_EVENT' }],
        },
        withChild.etag,
      );

      expect(withBookmark.revision).toBe(initial.revision + 3);
      expect(withBookmark.groups.find((group) => group.id === child.id)).toMatchObject({
        parentId: root.id,
        color: '#0088cc',
        position: 0,
      });
      expect(withBookmark.bookmarks[0]).toMatchObject({
        groupId: child.id,
        protocol: 'ssh',
        hostId: host.id,
        title: 'Gateway',
        quickCommands: [{ name: 'Health check', command: 'echo BOOKMARK_COMMAND_NOT_AN_EVENT' }],
      });
      expect(
        JSON.stringify(
          database.all("SELECT payload FROM domain_events WHERE type='bookmark.created'"),
        ),
      ).not.toContain('BOOKMARK_COMMAND_NOT_AN_EVENT');

      expect(() => service.createGroup({ name: 'Stale' }, initial.etag)).toThrowError(
        expect.objectContaining({ code: 'PRECONDITION_FAILED', status: 412 }),
      );
      expect(service.snapshot()).toEqual(withBookmark);
    } finally {
      database.close();
    }
  });

  it('moves before, after and inside atomically while preserving dense positions', async () => {
    const { database, host, service } = await fixture();
    try {
      let tree = service.snapshot();
      tree = service.createGroup({ name: 'A' }, tree.etag);
      tree = service.createGroup({ name: 'B' }, tree.etag);
      tree = service.createGroup({ name: 'C' }, tree.etag);
      const a = tree.groups.find((group) => group.name === 'A')!;
      const b = tree.groups.find((group) => group.name === 'B')!;
      const c = tree.groups.find((group) => group.name === 'C')!;
      tree = service.createBookmark(
        { protocol: 'ssh', hostId: host.id, title: 'Root bookmark' },
        tree.etag,
      );
      const bookmark = tree.bookmarks[0]!;

      tree = service.move(
        { source: groupRef(c.id), target: groupRef(a.id), position: 'before' },
        tree.etag,
      );
      expect(childOrder(tree, null)).toEqual([
        `group:${c.id}`,
        `group:${a.id}`,
        `group:${b.id}`,
        `bookmark:${bookmark.id}`,
      ]);

      tree = service.move(
        { source: groupRef(a.id), target: groupRef(b.id), position: 'inside' },
        tree.etag,
      );
      tree = service.move(
        { source: bookmarkRef(bookmark.id), target: groupRef(a.id), position: 'inside' },
        tree.etag,
      );
      expect(childOrder(tree, null)).toEqual([`group:${c.id}`, `group:${b.id}`]);
      expect(childOrder(tree, b.id)).toEqual([`group:${a.id}`]);
      expect(childOrder(tree, a.id)).toEqual([`bookmark:${bookmark.id}`]);

      const positions = [...tree.groups, ...tree.bookmarks]
        .filter((node) => ('parentId' in node ? node.parentId : node.groupId) === null)
        .map((node) => node.position)
        .sort((left, right) => left - right);
      expect(positions).toEqual([0, 1]);
      expect(
        JSON.stringify(
          database.all("SELECT type, payload FROM domain_events WHERE type LIKE 'bookmark%'"),
        ),
      ).not.toContain('cred_reference_only');
    } finally {
      database.close();
    }
  });

  it('rejects every descendant drop and rolls back revision, positions and event writes', async () => {
    const { database, service } = await fixture();
    try {
      let tree = service.snapshot();
      tree = service.createGroup({ name: 'Root' }, tree.etag);
      const root = tree.groups.find((group) => group.name === 'Root')!;
      tree = service.createGroup({ parentId: root.id, name: 'Child' }, tree.etag);
      const child = tree.groups.find((group) => group.name === 'Child')!;
      tree = service.createGroup({ parentId: child.id, name: 'Grandchild' }, tree.etag);
      const grandchild = tree.groups.find((group) => group.name === 'Grandchild')!;
      const before = service.snapshot();
      const eventCount = database.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM domain_events',
      )!.count;

      expect(() =>
        service.move(
          { source: groupRef(root.id), target: groupRef(grandchild.id), position: 'inside' },
          before.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
      expect(() =>
        service.move(
          { source: groupRef(root.id), target: groupRef(child.id), position: 'after' },
          before.etag,
        ),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

      expect(service.snapshot()).toEqual(before);
      expect(
        database.get<{ count: number }>('SELECT COUNT(*) AS count FROM domain_events')!.count,
      ).toBe(eventCount);
    } finally {
      database.close();
    }
  });

  it('promotes a deleted group children at the same position and searches bookmark ancestors', async () => {
    const { database, host, service } = await fixture();
    try {
      let tree = service.snapshot();
      tree = service.createGroup({ name: 'Before' }, tree.etag);
      tree = service.createGroup({ name: 'Container' }, tree.etag);
      tree = service.createGroup({ name: 'After' }, tree.etag);
      const before = tree.groups.find((group) => group.name === 'Before')!;
      const container = tree.groups.find((group) => group.name === 'Container')!;
      const after = tree.groups.find((group) => group.name === 'After')!;
      tree = service.createGroup({ parentId: container.id, name: 'Nested' }, tree.etag);
      const nested = tree.groups.find((group) => group.name === 'Nested')!;
      tree = service.createBookmark(
        {
          groupId: nested.id,
          protocol: 'ssh',
          hostId: host.id,
          title: '北京 Gateway',
          description: 'Production bastion',
        },
        tree.etag,
      );
      const bookmark = tree.bookmarks[0]!;

      expect(service.search('gateway', tree)).toEqual({
        bookmarkIds: [bookmark.id],
        ancestorGroupIds: [nested.id, container.id],
      });
      expect(service.search('production', tree).bookmarkIds).toEqual([bookmark.id]);
      expect(service.search('127.0.0.1', tree).bookmarkIds).toEqual([bookmark.id]);
      expect(service.search('operator@', tree).bookmarkIds).toEqual([bookmark.id]);
      expect(service.search(':22', tree).bookmarkIds).toEqual([bookmark.id]);
      expect(service.search('container', tree).bookmarkIds).toEqual([]);

      tree = service.deleteGroup(container.id, tree.etag);
      expect(childOrder(tree, null)).toEqual([
        `group:${before.id}`,
        `group:${nested.id}`,
        `group:${after.id}`,
      ]);
      expect(tree.groups.find((group) => group.id === nested.id)?.parentId).toBeNull();
      expect(tree.bookmarks.find((item) => item.id === bookmark.id)?.groupId).toBe(nested.id);
    } finally {
      database.close();
    }
  });
});
