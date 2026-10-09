import { describe, expect, it } from 'vitest';
import type { Bookmark, BookmarkGroup, BookmarkTree } from '../../packages/contracts/src/index';
import {
  buildVisibleBookmarkTree,
  canDropBookmarkTreeNode,
  nextBookmarkSearchResult,
} from '../../apps/desktop/src/renderer/src/app/bookmarks/tree-model';

const timestamp = '2026-09-12T00:00:00.000Z';
const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function group(
  value: number,
  name: string,
  parentId: string | null,
  position: number,
): BookmarkGroup {
  return {
    id: id(value),
    parentId,
    name,
    color: null,
    description: '',
    position,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
}

function bookmark(
  value: number,
  title: string,
  groupId: string | null,
  position: number,
): Bookmark {
  return {
    id: id(value),
    groupId,
    protocol: 'ssh',
    hostId: id(99_999),
    title,
    color: null,
    description: '',
    position,
    profileId: null,
    connectionProfileId: null,
    quickCommands: [],
    triggers: [],
    ftp: null,
    telnet: null,
    serial: null,
    rdp: null,
    vnc: null,
    spice: null,
    web: null,
    connectionDisplay: `operator@host-${value}.example.test:22`,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
}

function tree(groups: BookmarkGroup[], bookmarks: Bookmark[]): BookmarkTree {
  return { revision: 1, etag: '"bookmark-tree-v1"', groups, bookmarks };
}

describe('bookmark tree projection', () => {
  it('respects expansion and reveals every ancestor for a safe connection-field match', () => {
    const root = group(1, 'Production', null, 0);
    const child = group(2, 'Asia', root.id, 0);
    const gateway = { ...bookmark(3, 'Gateway', child.id, 0), description: 'Primary bastion' };
    const value = tree([root, child], [gateway]);

    expect(
      buildVisibleBookmarkTree(value, { expandedGroupIds: new Set(), query: '' }).rows.map(
        (row) => row.key,
      ),
    ).toEqual([`group:${root.id}`]);
    expect(
      buildVisibleBookmarkTree(value, {
        expandedGroupIds: new Set([root.id, child.id]),
        query: '',
      }).rows.map((row) => row.key),
    ).toEqual([`group:${root.id}`, `group:${child.id}`, `bookmark:${gateway.id}`]);

    const matched = buildVisibleBookmarkTree(value, {
      expandedGroupIds: new Set(),
      query: 'host-3.example',
    });
    expect(matched.rows.map((row) => row.key)).toEqual([
      `group:${root.id}`,
      `group:${child.id}`,
      `bookmark:${gateway.id}`,
    ]);
    expect(matched.matchedRowKeys).toEqual([`bookmark:${gateway.id}`]);
    expect(matched.rows.at(-1)?.highlight).not.toBeNull();
  });

  it('cycles keyboard results and rejects client-side descendant drops', () => {
    const root = group(1, 'Root', null, 0);
    const child = group(2, 'Child', root.id, 0);
    const first = bookmark(3, 'First', child.id, 0);
    const second = bookmark(4, 'Second', child.id, 1);
    const value = tree([root, child], [first, second]);
    const keys = [`bookmark:${first.id}`, `bookmark:${second.id}`];
    expect(nextBookmarkSearchResult(keys, undefined, 1)).toBe(keys[0]);
    expect(nextBookmarkSearchResult(keys, keys[0], -1)).toBe(keys[1]);
    expect(nextBookmarkSearchResult(keys, keys[1], 1)).toBe(keys[0]);
    expect(
      canDropBookmarkTreeNode(
        value,
        { kind: 'group', id: root.id },
        { kind: 'group', id: child.id },
        'inside',
      ),
    ).toBe(false);
    expect(
      canDropBookmarkTreeNode(
        value,
        { kind: 'bookmark', id: first.id },
        { kind: 'group', id: root.id },
        'inside',
      ),
    ).toBe(true);
  });

  it('projects ten thousand rows without recursion or duplicate results', () => {
    const root = group(1, 'Root', null, 0);
    const bookmarks = Array.from({ length: 10_000 }, (_, index) =>
      bookmark(index + 10, `Server ${index}`, root.id, index),
    );
    const visible = buildVisibleBookmarkTree(tree([root], bookmarks), {
      expandedGroupIds: new Set([root.id]),
      query: '',
    });
    expect(visible.rows).toHaveLength(10_001);
    expect(new Set(visible.rows.map((row) => row.key)).size).toBe(10_001);
    expect(visible.issues).toEqual([]);
  });

  it('sorts bookmark slots by title or connection display without changing group placement', () => {
    const root = group(1, 'Root', null, 0);
    const nested = group(2, 'Nested', root.id, 1);
    const zebra = {
      ...bookmark(3, 'Zebra', root.id, 0),
      connectionDisplay: 'operator@alpha.example.test:22',
    };
    const alpha = {
      ...bookmark(4, 'Alpha', root.id, 2),
      connectionDisplay: 'operator@zulu.example.test:22',
    };
    const value = tree([root, nested], [zebra, alpha]);
    const project = (sort: { field: 'title' | 'host'; direction: 'asc' | 'desc' }) =>
      buildVisibleBookmarkTree(value, {
        expandedGroupIds: new Set([root.id]),
        query: '',
        sort,
      }).rows.map((row) => row.title);

    expect(project({ field: 'title', direction: 'asc' })).toEqual([
      'Root',
      'Alpha - operator@zulu.example.test:22',
      'Nested',
      'Zebra - operator@alpha.example.test:22',
    ]);
    expect(project({ field: 'title', direction: 'desc' })).toEqual([
      'Root',
      'Zebra - operator@alpha.example.test:22',
      'Nested',
      'Alpha - operator@zulu.example.test:22',
    ]);
    expect(project({ field: 'host', direction: 'asc' })).toEqual([
      'Root',
      'Zebra - operator@alpha.example.test:22',
      'Nested',
      'Alpha - operator@zulu.example.test:22',
    ]);
  });
});
