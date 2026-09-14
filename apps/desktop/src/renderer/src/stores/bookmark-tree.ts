import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface BookmarkTreeUiState {
  expandedGroupIds: string[];
  query: string;
  selectedSearchRowKey: string | undefined;
  toggleGroup(id: string): void;
  setQuery(query: string): void;
  setSelectedSearchRowKey(key: string | undefined): void;
  retainGroups(ids: ReadonlySet<string>): void;
}

export const useBookmarkTreeUi = create<BookmarkTreeUiState>()(
  persist(
    (set) => ({
      expandedGroupIds: [],
      query: '',
      selectedSearchRowKey: undefined,
      toggleGroup: (id) =>
        set((state) => ({
          expandedGroupIds: state.expandedGroupIds.includes(id)
            ? state.expandedGroupIds.filter((groupId) => groupId !== id)
            : [...state.expandedGroupIds, id],
        })),
      setQuery: (query) => set({ query, selectedSearchRowKey: undefined }),
      setSelectedSearchRowKey: (selectedSearchRowKey) => set({ selectedSearchRowKey }),
      retainGroups: (ids) =>
        set((state) => ({
          expandedGroupIds: state.expandedGroupIds.filter((id) => ids.has(id)),
        })),
    }),
    {
      name: 'axterm-bookmark-tree-ui',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ expandedGroupIds }) => ({ expandedGroupIds }),
    },
  ),
);
