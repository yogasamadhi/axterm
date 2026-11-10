import type {
  Bookmark,
  BookmarkTreeSnapshot,
  CreateBookmarkGroupInput,
  UpdateBookmarkGroupInput,
  CreateBookmarkInput,
  UpdateBookmarkInput,
  MoveBookmarkTreeNodeInput,
} from '../domain/bookmarks/model.ts';
export interface BookmarkStore {
  snapshot(): BookmarkTreeSnapshot;
  createGroup(
    input: CreateBookmarkGroupInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot;
  updateGroup(
    id: string,
    input: UpdateBookmarkGroupInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot;
  deleteGroup(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot;
  createBookmark(input: CreateBookmarkInput, treeIfMatch: string | undefined): BookmarkTreeSnapshot;
  assertMutationTarget(groupId: string | null, treeIfMatch: string | undefined): void;
  createBookmarksBatch(
    inputs: CreateBookmarkInput[],
    treeIfMatch: string | undefined,
  ): { bookmarks: Bookmark[]; tree: BookmarkTreeSnapshot };
  updateBookmark(
    id: string,
    input: UpdateBookmarkInput,
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot;
  updateBookmarkWithPlacement(
    id: string,
    input: UpdateBookmarkInput & { groupId?: string | null | undefined },
    treeIfMatch: string | undefined,
  ): BookmarkTreeSnapshot;
  deleteBookmark(id: string, treeIfMatch: string | undefined): BookmarkTreeSnapshot;
  deleteBookmarksForHost(
    hostId: string,
    treeIfMatch: string | undefined,
  ): { bookmarkIds: string[]; tree: BookmarkTreeSnapshot };
  move(input: MoveBookmarkTreeNodeInput, treeIfMatch: string | undefined): BookmarkTreeSnapshot;
}
