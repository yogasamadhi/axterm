import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type {
  Bookmark,
  BookmarkDropPosition,
  BookmarkTree as BookmarkTreeValue,
  BookmarkTreeNodeRef,
} from '@workspace/contracts';
import {
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUpAZ,
  ChevronDown,
  ChevronRight,
  Code2,
  CopyPlus,
  Folder,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useBookmarkTreeUi } from '../../stores/bookmark-tree';
import { useI18n } from '../../i18n/context';
import {
  buildVisibleBookmarkTree,
  canDropBookmarkTreeNode,
  nextBookmarkSearchResult,
  type BookmarkTreeSort,
  type BookmarkTreeRow,
} from './tree-model';
import './bookmark-tree.css';
import { calculateVirtualWindow } from '../virtual-window';

const rowHeight = 26;
const overscan = 8;

export function BookmarkTree({
  tree,
  busy = false,
  onConnect,
  onEdit,
  onDuplicate,
  onDelete,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMove,
  onImportSshConfig,
}: {
  tree: BookmarkTreeValue;
  busy?: boolean;
  onConnect(bookmark: Bookmark): void;
  onEdit(bookmark: Bookmark): void;
  onDuplicate(bookmark: Bookmark): void;
  onDelete(bookmark: Bookmark): void;
  onCreateGroup(parentId: string | null): void;
  onRenameGroup(id: string): void;
  onDeleteGroup(id: string): void;
  onMove(
    source: BookmarkTreeNodeRef,
    target: BookmarkTreeNodeRef,
    position: BookmarkDropPosition,
  ): void;
  onImportSshConfig(): void;
}) {
  const { x } = useI18n();
  const expandedGroupIds = useBookmarkTreeUi((state) => state.expandedGroupIds);
  const query = useBookmarkTreeUi((state) => state.query);
  const selectedSearchRowKey = useBookmarkTreeUi((state) => state.selectedSearchRowKey);
  const toggleGroup = useBookmarkTreeUi((state) => state.toggleGroup);
  const setQuery = useBookmarkTreeUi((state) => state.setQuery);
  const setSelectedSearchRowKey = useBookmarkTreeUi((state) => state.setSelectedSearchRowKey);
  const retainGroups = useBookmarkTreeUi((state) => state.retainGroups);
  const viewport = useRef<HTMLDivElement>(null);
  const contextMenuElement = useRef<HTMLDivElement>(null);
  const sortMenuElement = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const [dragging, setDragging] = useState<BookmarkTreeNodeRef>();
  const [drop, setDrop] = useState<{
    target: BookmarkTreeNodeRef;
    position: BookmarkDropPosition;
    allowed: boolean;
  }>();
  const [contextMenu, setContextMenu] = useState<{
    kind: 'group' | 'bookmark';
    id: string;
    x: number;
    y: number;
  }>();
  const [sort, setSort] = useState<BookmarkTreeSort | null>(null);
  const [sortOpen, setSortOpen] = useState(false);

  const visible = useMemo(
    () =>
      buildVisibleBookmarkTree(tree, {
        expandedGroupIds: new Set(expandedGroupIds),
        query,
        sort,
      }),
    [expandedGroupIds, query, sort, tree],
  );
  const bookmarks = useMemo(
    () => new Map(tree.bookmarks.map((bookmark) => [bookmark.id, bookmark])),
    [tree.bookmarks],
  );

  useEffect(
    () => retainGroups(new Set(tree.groups.map((group) => group.id))),
    [retainGroups, tree],
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!query) {
      if (selectedSearchRowKey) setSelectedSearchRowKey(undefined);
      return;
    }
    if (selectedSearchRowKey && !visible.matchedRowKeys.includes(selectedSearchRowKey))
      setSelectedSearchRowKey(undefined);
  }, [query, selectedSearchRowKey, setSelectedSearchRowKey, visible.matchedRowKeys]);
  useEffect(() => {
    if (!selectedSearchRowKey || !viewport.current) return;
    const index = visible.rows.findIndex((row) => row.key === selectedSearchRowKey);
    if (index < 0) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < viewport.current.scrollTop) viewport.current.scrollTop = top;
    else if (bottom > viewport.current.scrollTop + viewport.current.clientHeight)
      viewport.current.scrollTop = bottom - viewport.current.clientHeight;
  }, [selectedSearchRowKey, visible.rows]);
  useEffect(() => {
    if (!contextMenu) return;
    contextMenuElement.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = () => setContextMenu(undefined);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('blur', dismiss);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);
  useEffect(() => {
    if (!sortOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!sortMenuElement.current?.contains(event.target as Node)) setSortOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [sortOpen]);

  const { start, end } = calculateVirtualWindow({
    itemCount: visible.rows.length,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan,
  });
  const renderedRows = visible.rows.slice(start, end);

  function moveSearch(direction: 1 | -1) {
    setSelectedSearchRowKey(
      nextBookmarkSearchResult(visible.matchedRowKeys, selectedSearchRowKey, direction),
    );
  }

  function activateSearchResult() {
    if (!selectedSearchRowKey?.startsWith('bookmark:')) return;
    const bookmark = bookmarks.get(selectedSearchRowKey.slice('bookmark:'.length));
    if (bookmark) onConnect(bookmark);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSearch(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activateSearchResult();
    } else if (event.key === 'Escape') {
      setQuery('');
    }
  }

  function updateDrop(event: DragEvent<HTMLDivElement>, row: BookmarkTreeRow) {
    if (!dragging) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientY - bounds.top;
    const position: BookmarkDropPosition =
      row.kind === 'group' && offset > bounds.height / 3 && offset < (bounds.height * 2) / 3
        ? 'inside'
        : offset < bounds.height / 2
          ? 'before'
          : 'after';
    const target = { kind: row.kind, id: row.id } satisfies BookmarkTreeNodeRef;
    setDrop({
      target,
      position,
      allowed: canDropBookmarkTreeNode(tree, dragging, target, position),
    });
  }

  function commitDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (dragging && drop?.allowed) onMove(dragging, drop.target, drop.position);
    setDragging(undefined);
    setDrop(undefined);
  }

  function openContextMenu(kind: 'group' | 'bookmark', id: string, x: number, y: number) {
    setContextMenu({
      kind,
      id,
      x: Math.max(4, Math.min(x, window.innerWidth - 188)),
      y: Math.max(4, Math.min(y, window.innerHeight - (kind === 'group' ? 132 : 164))),
    });
  }

  function invokeBookmark(id: string, action: (bookmark: Bookmark) => void) {
    const bookmark = bookmarks.get(id);
    setContextMenu(undefined);
    if (bookmark) action(bookmark);
  }

  function cycleSort(field: BookmarkTreeSort['field']) {
    setSort((current) => {
      if (current?.field !== field) return { field, direction: 'asc' };
      if (current.direction === 'asc') return { field, direction: 'desc' };
      return null;
    });
  }

  return (
    <section className="bookmark-tree-panel" aria-label={x('bookmarkTree.title')}>
      <div className="bookmark-tree-toolbar" ref={sortMenuElement}>
        <label className="bookmark-tree-search">
          <Search size={13} />
          <input
            aria-label={x('bookmarkTree.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {query && (
            <button aria-label={x('bookmarkTree.clearSearch')} onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <button
          className="bookmark-tree-add-root"
          disabled={busy}
          title={x('bookmarkTree.newRootGroup')}
          onClick={() => onCreateGroup(null)}
        >
          <Plus size={13} />
        </button>
        <button
          className={sort ? 'bookmark-tree-sort active' : 'bookmark-tree-sort'}
          aria-label={x('bookmarkTree.sort')}
          aria-expanded={sortOpen}
          title={x('bookmarkTree.sort')}
          onClick={() => setSortOpen((open) => !open)}
        >
          <ArrowDownUp size={13} />
        </button>
        {sortOpen && (
          <div className="bookmark-sort-menu" role="menu" aria-label={x('bookmarkTree.sortMode')}>
            <button role="menuitem" onClick={() => cycleSort('title')}>
              {sort?.field === 'title' && sort.direction === 'desc' ? (
                <ArrowUpAZ size={12} />
              ) : (
                <ArrowDownAZ size={12} />
              )}
              {x('bookmarkTree.bookmarkTitle')}
              <small>{sort?.field === 'title' ? sort.direction : '—'}</small>
            </button>
            <button role="menuitem" onClick={() => cycleSort('host')}>
              {sort?.field === 'host' && sort.direction === 'desc' ? (
                <ArrowUpAZ size={12} />
              ) : (
                <ArrowDownAZ size={12} />
              )}
              {x('bookmarkTree.host')}
              <small>{sort?.field === 'host' ? sort.direction : '—'}</small>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setSortOpen(false);
                onImportSshConfig();
              }}
            >
              <Code2 size={12} />
              {x('bookmarkTree.importSshConfig')}
              <small>{x('bookmarkTree.jsonPreview')}</small>
            </button>
          </div>
        )}
      </div>
      {query && (
        <span className="bookmark-search-announcement" role="status">
          {x('bookmarkTree.matches', { count: visible.matchedRowKeys.length })}
        </span>
      )}
      <div
        className="bookmark-tree-viewport"
        ref={viewport}
        role="tree"
        aria-label={x('bookmarkTree.saved')}
        aria-busy={busy}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined);
        }}
      >
        <div className="bookmark-tree-spacer" style={{ height: visible.rows.length * rowHeight }}>
          <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
            {renderedRows.map((row) => {
              const selected = row.key === selectedSearchRowKey;
              const dropState =
                drop?.target.kind === row.kind && drop.target.id === row.id ? drop : undefined;
              return (
                <div
                  className={`bookmark-tree-row ${selected ? 'search-selected' : ''} ${
                    dropState ? `drop-${dropState.position}` : ''
                  } ${dropState && !dropState.allowed ? 'drop-invalid' : ''}`}
                  key={row.key}
                  data-bookmark-id={row.kind === 'bookmark' ? row.id : undefined}
                  data-bookmark-title={
                    row.kind === 'bookmark' ? bookmarks.get(row.id)?.title : undefined
                  }
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.kind === 'group' ? row.expanded : undefined}
                  aria-selected={selected}
                  tabIndex={0}
                  title={row.description ? `${row.title} - ${row.description}` : row.title}
                  style={{ paddingLeft: row.depth * 12 + (row.kind === 'bookmark' ? 4 : 0) }}
                  draggable={!busy}
                  onDragStart={(event) => {
                    const source = { kind: row.kind, id: row.id } satisfies BookmarkTreeNodeRef;
                    setDragging(source);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-axterm-bookmark-node', row.key);
                  }}
                  onDragEnd={() => {
                    setDragging(undefined);
                    setDrop(undefined);
                  }}
                  onDragOver={(event) => updateDrop(event, row)}
                  onDrop={commitDrop}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openContextMenu(row.kind, row.id, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (row.kind === 'group') toggleGroup(row.id);
                      else invokeBookmark(row.id, onConnect);
                    } else if (
                      event.key === 'ContextMenu' ||
                      (event.shiftKey && event.key === 'F10')
                    ) {
                      event.preventDefault();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      openContextMenu(row.kind, row.id, bounds.left + 24, bounds.bottom);
                    }
                  }}
                  onDoubleClick={() => {
                    if (row.kind === 'group') toggleGroup(row.id);
                    else {
                      const bookmark = bookmarks.get(row.id);
                      if (bookmark) onConnect(bookmark);
                    }
                  }}
                >
                  <button
                    className="bookmark-row-main"
                    onClick={() => {
                      if (row.kind === 'group') toggleGroup(row.id);
                      else {
                        const bookmark = bookmarks.get(row.id);
                        if (bookmark) onConnect(bookmark);
                      }
                    }}
                  >
                    <span className="bookmark-row-chevron">
                      {row.kind === 'group' && row.hasChildren ? (
                        row.expanded ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )
                      ) : null}
                    </span>
                    {row.kind === 'group' ? (
                      row.color ? (
                        <i
                          className="bookmark-group-color"
                          style={{ backgroundColor: row.color }}
                        />
                      ) : (
                        <Folder size={13} />
                      )
                    ) : (
                      row.color && (
                        <i className="bookmark-color" style={{ backgroundColor: row.color }} />
                      )
                    )}
                    <span className="bookmark-row-title">
                      <HighlightedTitle title={row.title} highlight={row.highlight} />
                    </span>
                    {row.protocol && row.protocol !== 'ssh' && <small>{row.protocol}</small>}
                  </button>
                  <div className="bookmark-row-actions">
                    {row.kind === 'group' ? (
                      <>
                        <button
                          title={x('bookmarkTree.newChildGroup')}
                          aria-label={x('bookmarkTree.newChildGroupIn', { title: row.title })}
                          onClick={() => onCreateGroup(row.id)}
                        >
                          <Plus size={11} />
                        </button>
                        <button
                          title={x('bookmarkTree.renameGroup')}
                          aria-label={x('bookmarkTree.rename', { title: row.title })}
                          onClick={() => onRenameGroup(row.id)}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          title={x('bookmarkTree.deleteGroup')}
                          aria-label={x('bookmarkTree.deleteNamed', { title: row.title })}
                          onClick={() => onDeleteGroup(row.id)}
                        >
                          <Trash2 size={11} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          title={x('bookmarkTree.connect')}
                          aria-label={x('bookmarkTree.connectNamed', { title: row.title })}
                          onClick={() => invokeBookmark(row.id, onConnect)}
                        >
                          <Play size={11} />
                        </button>
                        <button
                          title={x('bookmarkTree.moreActions')}
                          aria-label={x('bookmarkTree.moreActionsFor', { title: row.title })}
                          onClick={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            openContextMenu(row.kind, row.id, bounds.right, bounds.bottom);
                          }}
                        >
                          <MoreHorizontal size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {!visible.rows.length && (
          <div className="bookmark-tree-empty">
            {x(query ? 'bookmarkTree.noMatches' : 'bookmarkTree.empty')}
          </div>
        )}
      </div>
      {!!visible.issues.length && (
        <div className="bookmark-tree-warning">
          {x('bookmarkTree.repairedIssues', { count: visible.issues.length })}
        </div>
      )}
      {contextMenu && (
        <div
          className="bookmark-context-menu"
          ref={contextMenuElement}
          role="menu"
          aria-label={x(
            contextMenu.kind === 'bookmark'
              ? 'bookmarkTree.bookmarkActions'
              : 'bookmarkTree.groupActions',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
            const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
            const next =
              (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {contextMenu.kind === 'bookmark' ? (
            <>
              <button role="menuitem" onClick={() => invokeBookmark(contextMenu.id, onConnect)}>
                <Play size={12} /> {x('bookmarkTree.connect')}
              </button>
              <button role="menuitem" onClick={() => invokeBookmark(contextMenu.id, onEdit)}>
                <Pencil size={12} /> {x('bookmarkTree.edit')}
              </button>
              <button role="menuitem" onClick={() => invokeBookmark(contextMenu.id, onDuplicate)}>
                <CopyPlus size={12} /> {x('bookmarkTree.duplicate')}
              </button>
              <button
                className="danger-item"
                role="menuitem"
                onClick={() => invokeBookmark(contextMenu.id, onDelete)}
              >
                <Trash2 size={12} /> {x('bookmarkTree.delete')}
              </button>
            </>
          ) : (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  setContextMenu(undefined);
                  onCreateGroup(contextMenu.id);
                }}
              >
                <Plus size={12} /> {x('bookmarkTree.newChildGroup')}
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setContextMenu(undefined);
                  onRenameGroup(contextMenu.id);
                }}
              >
                <Pencil size={12} /> {x('bookmarkTree.renameAction')}
              </button>
              <button
                className="danger-item"
                role="menuitem"
                onClick={() => {
                  setContextMenu(undefined);
                  onDeleteGroup(contextMenu.id);
                }}
              >
                <Trash2 size={12} /> {x('bookmarkTree.delete')}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function HighlightedTitle({
  title,
  highlight,
}: {
  title: string;
  highlight: BookmarkTreeRow['highlight'];
}) {
  if (!highlight) return title;
  return (
    <>
      {title.slice(0, highlight.start)}
      <mark>{title.slice(highlight.start, highlight.end)}</mark>
      {title.slice(highlight.end)}
    </>
  );
}
