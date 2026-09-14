import type {
  Bookmark,
  BookmarkDropPosition,
  BookmarkGroup,
  BookmarkTree,
  BookmarkTreeNodeRef,
} from '@workspace/contracts';

export interface BookmarkTreeRow {
  key: string;
  kind: BookmarkTreeNodeRef['kind'];
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  description: string;
  color: string | null;
  protocol: Bookmark['protocol'] | null;
  connectionDisplay: string | null;
  expanded: boolean;
  hasChildren: boolean;
  matched: boolean;
  highlight: { start: number; end: number } | null;
}

export interface VisibleBookmarkTree {
  rows: BookmarkTreeRow[];
  matchedRowKeys: string[];
  issues: string[];
}

export interface BookmarkTreeSort {
  field: 'title' | 'host';
  direction: 'asc' | 'desc';
}

interface TreeNode {
  kind: BookmarkTreeNodeRef['kind'];
  id: string;
  parentId: string | null;
  position: number;
  group?: BookmarkGroup;
  bookmark?: Bookmark;
}

export function buildVisibleBookmarkTree(
  tree: BookmarkTree,
  options: {
    expandedGroupIds: ReadonlySet<string>;
    query: string;
    sort?: BookmarkTreeSort | null;
  },
): VisibleBookmarkTree {
  const groups = new Map(tree.groups.map((group) => [group.id, group]));
  const children = new Map<string, TreeNode[]>();
  const issues: string[] = [];
  const rootKey = '';
  const append = (parentId: string | null, node: TreeNode) => {
    const key = parentId ?? rootKey;
    const bucket = children.get(key) ?? [];
    bucket.push(node);
    children.set(key, bucket);
  };

  for (const group of tree.groups) {
    if (group.parentId && !groups.has(group.parentId)) {
      issues.push(`Group ${group.id} references a missing parent`);
      append(null, {
        kind: 'group',
        id: group.id,
        parentId: null,
        position: group.position,
        group,
      });
    } else {
      append(group.parentId, {
        kind: 'group',
        id: group.id,
        parentId: group.parentId,
        position: group.position,
        group,
      });
    }
  }
  for (const bookmark of tree.bookmarks) {
    const parentId = bookmark.groupId && groups.has(bookmark.groupId) ? bookmark.groupId : null;
    if (bookmark.groupId && !parentId)
      issues.push(`Bookmark ${bookmark.id} references a missing group`);
    append(parentId, {
      kind: 'bookmark',
      id: bookmark.id,
      parentId,
      position: bookmark.position,
      bookmark,
    });
  }
  for (const bucket of children.values()) bucket.sort(compareNodes);

  const query = options.query.trim().toLocaleLowerCase();
  const matchingBookmarks = new Set<string>();
  const visibleGroups = new Set<string>();
  if (query) {
    for (const bookmark of tree.bookmarks) {
      const generatedTitle = bookmark.connectionDisplay
        ? `${bookmark.title} - ${bookmark.connectionDisplay}`
        : bookmark.title;
      if (
        !generatedTitle.toLocaleLowerCase().includes(query) &&
        !bookmark.description.toLocaleLowerCase().includes(query)
      )
        continue;
      matchingBookmarks.add(bookmark.id);
      const chain = new Set<string>();
      let cursor = bookmark.groupId;
      while (cursor && !visibleGroups.has(cursor)) {
        if (chain.has(cursor)) {
          issues.push(`Cycle detected at group ${cursor}`);
          break;
        }
        chain.add(cursor);
        visibleGroups.add(cursor);
        cursor = groups.get(cursor)?.parentId ?? null;
      }
    }
  }

  const rows: BookmarkTreeRow[] = [];
  const matchedRowKeys: string[] = [];
  const visitedGroups = new Set<string>();
  const stack = orderedChildren(children.get(rootKey) ?? [], options.sort)
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  while (stack.length) {
    const entry = stack.pop()!;
    const { node, depth } = entry;
    if (node.kind === 'bookmark') {
      const bookmark = node.bookmark!;
      if (query && !matchingBookmarks.has(bookmark.id)) continue;
      const generatedTitle = bookmark.connectionDisplay
        ? `${bookmark.title} - ${bookmark.connectionDisplay}`
        : bookmark.title;
      const index = query ? generatedTitle.toLocaleLowerCase().indexOf(query) : -1;
      const row: BookmarkTreeRow = {
        key: `bookmark:${bookmark.id}`,
        kind: 'bookmark',
        id: bookmark.id,
        parentId: node.parentId,
        depth,
        title: generatedTitle,
        description: bookmark.description,
        color: bookmark.color,
        protocol: bookmark.protocol,
        connectionDisplay: bookmark.connectionDisplay,
        expanded: false,
        hasChildren: false,
        matched: Boolean(query),
        highlight: index < 0 ? null : { start: index, end: index + query.length },
      };
      rows.push(row);
      if (query) matchedRowKeys.push(row.key);
      continue;
    }

    const group = node.group!;
    if (query && !visibleGroups.has(group.id)) continue;
    if (visitedGroups.has(group.id)) {
      issues.push(`Group ${group.id} appears more than once`);
      continue;
    }
    visitedGroups.add(group.id);
    const groupChildren = children.get(group.id) ?? [];
    const expanded = Boolean(query) || options.expandedGroupIds.has(group.id);
    rows.push({
      key: `group:${group.id}`,
      kind: 'group',
      id: group.id,
      parentId: node.parentId,
      depth,
      title: group.name,
      description: group.description,
      color: group.color,
      protocol: null,
      connectionDisplay: null,
      expanded,
      hasChildren: groupChildren.length > 0,
      matched: false,
      highlight: null,
    });
    if (!expanded) continue;
    const ordered = orderedChildren(groupChildren, options.sort);
    for (let index = ordered.length - 1; index >= 0; index -= 1)
      stack.push({ node: ordered[index]!, depth: depth + 1 });
  }

  return { rows, matchedRowKeys, issues };
}

export function nextBookmarkSearchResult(
  matchedRowKeys: readonly string[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (!matchedRowKeys.length) return undefined;
  const currentIndex = current ? matchedRowKeys.indexOf(current) : -1;
  const start = currentIndex < 0 ? (direction === 1 ? -1 : 0) : currentIndex;
  return matchedRowKeys[(start + direction + matchedRowKeys.length) % matchedRowKeys.length];
}

export function canDropBookmarkTreeNode(
  tree: BookmarkTree,
  source: BookmarkTreeNodeRef,
  target: BookmarkTreeNodeRef,
  position: BookmarkDropPosition,
): boolean {
  if (source.kind === target.kind && source.id === target.id) return false;
  if (position === 'inside' && target.kind !== 'group') return false;
  if (source.kind !== 'group') return true;

  const groups = new Map(tree.groups.map((group) => [group.id, group]));
  const targetGroup = target.kind === 'group' ? groups.get(target.id) : undefined;
  const targetBookmark =
    target.kind === 'bookmark'
      ? tree.bookmarks.find((bookmark) => bookmark.id === target.id)
      : null;
  let cursor =
    position === 'inside' ? targetGroup?.id : (targetGroup?.parentId ?? targetBookmark?.groupId);
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === source.id || visited.has(cursor)) return false;
    visited.add(cursor);
    cursor = groups.get(cursor)?.parentId ?? null;
  }
  return true;
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  return (
    left.position - right.position ||
    Number(left.kind === 'bookmark') - Number(right.kind === 'bookmark') ||
    nodeTitle(left).localeCompare(nodeTitle(right)) ||
    left.id.localeCompare(right.id)
  );
}

function nodeTitle(node: TreeNode): string {
  return node.group?.name ?? node.bookmark?.title ?? '';
}

function orderedChildren(
  children: readonly TreeNode[],
  sort: BookmarkTreeSort | null | undefined,
): TreeNode[] {
  if (!sort) return [...children];
  const bookmarks = children
    .filter((node) => node.kind === 'bookmark')
    .sort((left, right) => {
      const leftValue = bookmarkSortValue(left.bookmark!, sort.field);
      const rightValue = bookmarkSortValue(right.bookmark!, sort.field);
      const compared = leftValue.localeCompare(rightValue) || left.id.localeCompare(right.id);
      return sort.direction === 'asc' ? compared : -compared;
    });
  let bookmarkIndex = 0;
  return children.map((node) => (node.kind === 'bookmark' ? bookmarks[bookmarkIndex++]! : node));
}

function bookmarkSortValue(bookmark: Bookmark, field: BookmarkTreeSort['field']): string {
  const value = field === 'title' ? bookmark.title : (bookmark.connectionDisplay ?? '');
  return value.toLocaleLowerCase();
}
