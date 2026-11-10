import type { BookmarkGroupDraft } from './bookmark-group-dialog.tsx';
export type GroupDialogSelection =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; id: string; initialValue: BookmarkGroupDraft };
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
interface TreeUiState {
  readonly managerOpen: boolean;
  setManagerOpen(value: boolean): void;
  readonly groupDialog: GroupDialogSelection | undefined;
  setGroupDialog(value: GroupDialogSelection | undefined): void;
  readonly expandedGroupIds: readonly string[];
  readonly query: string;
  readonly selectedSearchRowKey: string | undefined;
  toggleGroup(id: string): void;
  setQuery(value: string): void;
  setSelectedSearchRowKey(value: string | undefined): void;
  retainGroups(ids: ReadonlySet<string>): void;
}
export class BookmarkTreeUiStore {
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private state: TreeUiState;
  constructor() {
    let expandedGroupIds: string[] = [];
    try {
      const text = localStorage.getItem('axterm-bookmark-tree-ui');
      if (text && text.length <= 128 * 1024) {
        const value = JSON.parse(text)?.state?.expandedGroupIds;
        if (Array.isArray(value))
          expandedGroupIds = value
            .filter(
              (item: unknown): item is string => typeof item === 'string' && item.length <= 128,
            )
            .slice(0, 4096);
      }
    } catch {
      /* Workspace preferences never prevent loading authoritative facts. */
    }
    this.state = {
      managerOpen: false,
      setManagerOpen: (managerOpen) => this.update({ managerOpen }),
      groupDialog: undefined,
      setGroupDialog: (groupDialog) => this.update({ groupDialog }),
      expandedGroupIds,
      query: '',
      selectedSearchRowKey: undefined,
      toggleGroup: (id) => {
        const current = this.state.expandedGroupIds;
        this.update({
          expandedGroupIds: current.includes(id)
            ? current.filter((value) => value !== id)
            : [...current, id].slice(-4096),
        });
      },
      setQuery: (query) => this.update({ query, selectedSearchRowKey: undefined }),
      setSelectedSearchRowKey: (selectedSearchRowKey) => this.update({ selectedSearchRowKey }),
      retainGroups: (ids) => {
        const kept = this.state.expandedGroupIds.filter((id) => ids.has(id));
        if (kept.length !== this.state.expandedGroupIds.length)
          this.update({ expandedGroupIds: kept });
      },
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) throw new Error('CATALOG_UI_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(
    value: Partial<
      Pick<
        TreeUiState,
        'expandedGroupIds' | 'query' | 'selectedSearchRowKey' | 'groupDialog' | 'managerOpen'
      >
    >,
  ) {
    if (this.closed) return;
    this.state = { ...this.state, ...value };
    if (value.expandedGroupIds)
      try {
        localStorage.setItem(
          'axterm-bookmark-tree-ui',
          JSON.stringify({ state: { expandedGroupIds: value.expandedGroupIds }, version: 0 }),
        );
      } catch {
        /* Preferences may be unavailable. */
      }
    for (const listener of this.listeners) listener();
  }
  close() {
    this.closed = true;
    this.listeners.clear();
  }
}
const Owner = createContext<BookmarkTreeUiStore | undefined>(undefined);
export function BookmarkTreeUi({
  store,
  children,
}: {
  store: BookmarkTreeUiStore;
  children: ReactNode;
}) {
  return <Owner.Provider value={store}>{children}</Owner.Provider>;
}
export function useBookmarkTreeUi<T>(select: (state: TreeUiState) => T): T {
  const store = useContext(Owner);
  if (!store) throw new Error('CATALOG_TREE_UI_UNAVAILABLE');
  return select(useSyncExternalStore(store.subscribe, store.getSnapshot));
}
