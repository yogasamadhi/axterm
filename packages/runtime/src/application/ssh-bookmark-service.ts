import {
  createSshBookmarkSchema,
  updateSshBookmarkSchema,
  type CreateSshBookmarkInput,
  type DeleteSshBookmarkEntryResult,
  type DeleteSshBookmarkResult,
  type SshBookmarkMutationResult,
  type UpdateSshBookmarkInput,
} from '@workspace/contracts';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';

/**
 * Coordinates the two aggregates behind a saved SSH destination. Both repository
 * operations run under the same UnitOfWork, so neither an orphan Host nor a stale
 * Bookmark can be committed when the other operation fails.
 */
export class SshBookmarkService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly hosts: ProductRepository,
    private readonly bookmarks: BookmarkTreeService,
  ) {}

  create(
    input: CreateSshBookmarkInput,
    treeIfMatch: string | undefined,
  ): SshBookmarkMutationResult {
    const command = createSshBookmarkSchema.parse(input);
    let result: SshBookmarkMutationResult | undefined;
    this.unitOfWork.transaction(() => {
      const createdHost = this.hosts.createHost({
        ...command.host,
        // BookmarkGroup is the only placement model for newly saved destinations.
        groupId: null,
      });
      const tree = this.bookmarks.createBookmark(
        {
          ...command.bookmark,
          protocol: 'ssh',
          hostId: createdHost.id,
        },
        treeIfMatch,
      );
      const bookmark = tree.bookmarks.find(({ hostId }) => hostId === createdHost.id);
      if (!bookmark) throw new Error('SSH bookmark transaction did not create a Bookmark');
      result = { host: createdHost, bookmark, tree };
    });
    if (!result) throw new Error('SSH bookmark transaction did not return a result');
    return result;
  }

  updateBookmark(
    bookmarkId: string,
    input: UpdateSshBookmarkInput,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): SshBookmarkMutationResult {
    const command = updateSshBookmarkSchema.parse(input);
    let result: SshBookmarkMutationResult | undefined;
    this.unitOfWork.transaction(() => {
      const currentBookmark = this.requireSshBookmark(bookmarkId);
      const currentHost = this.hosts.assertHostVersion(currentBookmark.hostId, hostIfMatch);
      const targetGroupId =
        command.bookmark.groupId === undefined ? currentBookmark.groupId : command.bookmark.groupId;

      // Check both optimistic-concurrency boundaries and the destination before
      // either aggregate is written. The repositories check them again at write
      // time, which also keeps their standalone entry points safe.
      this.bookmarks.assertMutationTarget(targetGroupId, treeIfMatch);
      const host = Object.keys(command.host).length
        ? this.hosts.updateHost(currentHost.id, command.host, hostIfMatch)
        : currentHost;

      // A Host-only edit still advances the tree once because connectionDisplay
      // is projected into the returned Bookmark tree.
      const tree = this.bookmarks.updateBookmarkWithPlacement(
        bookmarkId,
        command.bookmark,
        treeIfMatch,
      );
      const bookmark = tree.bookmarks.find(({ id }) => id === bookmarkId);
      if (!bookmark) throw new ApplicationError('INVALID_STATE', 'Updated SSH Bookmark is missing');
      result = { host, bookmark, tree };
    });
    if (!result) throw new Error('SSH bookmark update transaction did not return a result');
    return result;
  }

  deleteBookmark(
    bookmarkId: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): DeleteSshBookmarkEntryResult {
    let result: DeleteSshBookmarkEntryResult | undefined;
    this.unitOfWork.transaction(() => {
      const bookmark = this.requireSshBookmark(bookmarkId);
      this.hosts.assertHostVersion(bookmark.hostId, hostIfMatch);
      this.bookmarks.assertMutationTarget(bookmark.groupId, treeIfMatch);

      const tree = this.bookmarks.deleteBookmark(bookmarkId, treeIfMatch);
      const remainingBookmarkIds = tree.bookmarks
        .filter(({ hostId }) => hostId === bookmark.hostId)
        .map(({ id }) => id);
      const retainedBy = this.hosts.hostRetentionReasons(bookmark.hostId);
      const hostDeleted = retainedBy.length === 0;
      if (hostDeleted) this.hosts.deleteHost(bookmark.hostId, hostIfMatch);

      result = {
        bookmarkId,
        hostId: bookmark.hostId,
        hostDeleted,
        remainingBookmarkIds,
        retainedBy,
        tree: this.bookmarks.snapshot(),
      };
    });
    if (!result) throw new Error('SSH bookmark delete transaction did not return a result');
    return result;
  }

  delete(
    hostId: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): DeleteSshBookmarkResult {
    let result: DeleteSshBookmarkResult | undefined;
    this.unitOfWork.transaction(() => {
      // Validate both representations before the first durable write. Repository
      // methods validate again at write time to retain optimistic concurrency.
      this.hosts.assertHostVersion(hostId, hostIfMatch);
      const deletion = this.bookmarks.deleteBookmarksForHost(hostId, treeIfMatch);
      this.hosts.deleteHost(hostId, hostIfMatch);
      result = { hostId, bookmarkIds: deletion.bookmarkIds, tree: this.bookmarks.snapshot() };
    });
    if (!result) throw new Error('SSH bookmark delete transaction did not return a result');
    return result;
  }

  private requireSshBookmark(bookmarkId: string) {
    const bookmark = this.bookmarks.getBookmark(bookmarkId);
    if (bookmark.protocol !== 'ssh' || !bookmark.hostId)
      throw new ApplicationError('CONFLICT', 'Bookmark is not an SSH destination', 409);
    return bookmark as typeof bookmark & { hostId: string };
  }
}
