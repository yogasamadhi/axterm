import type {
  Host,
  HostGroup,
  CreateHostInput,
  UpdateHostInput,
  CreateHostGroupInput,
  ConnectionProfileInput,
  ConnectionProfilePatch,
  ConnectionHistoryPageQuery,
  CreateSshBookmarkInput,
  UpdateSshBookmarkInput,
  CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type { StorageCommandJournal } from '@axterm/plugin-api/storage';
import type { HostStore } from '../ports/hosts.ts';
import type { CatalogHistory } from '../ports/history.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { BookmarkTreeService } from './bookmark-tree-service.ts';
import type { SshBookmarkService } from './ssh-bookmark-service.ts';
import type { ConnectionProfileService } from './connection-profile-service.ts';
import type {
  CreateBookmarkInput,
  CreateBookmarkGroupInput,
  UpdateBookmarkInput,
  UpdateBookmarkGroupInput,
  MoveBookmarkTreeNodeInput,
} from '../domain/bookmarks/model.ts';

/** Owns catalog fact commands. SQL and cross-owner reference projections enter only through ports. */
export class CatalogApplication {
  constructor(
    private readonly work: UnitOfWork,
    private readonly commands: StorageCommandJournal,
    readonly hosts: HostStore,
    readonly bookmarks: BookmarkTreeService,
    readonly profiles: ConnectionProfileService,
    readonly ssh: SshBookmarkService,
    readonly history: CatalogHistory,
    private readonly cursor: () => number,
  ) {}
  createHost(key: string, input: CreateHostInput): CatalogReceipt {
    return this.write(key, 'createHost', input, () => this.entity(this.hosts.createHost(input)));
  }
  updateHost(
    key: string,
    id: string,
    input: UpdateHostInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateHost', { id, input, ifMatch }, () =>
      this.entity(this.hosts.updateHost(id, input, ifMatch)),
    );
  }
  deleteHost(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteHost', { id, ifMatch }, () => {
      this.hosts.deleteHost(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), deletedCount: 1 };
    });
  }
  createHostGroup(key: string, input: CreateHostGroupInput): CatalogReceipt {
    return this.write(key, 'createHostGroup', input, () =>
      this.entity(
        this.hosts.createHostGroup({ name: input.name, sortOrder: input.sortOrder ?? 0 }),
      ),
    );
  }
  updateHostGroup(
    key: string,
    id: string,
    input: { name?: string | undefined; sortOrder?: number | undefined },
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateHostGroup', { id, input, ifMatch }, () =>
      this.entity(this.hosts.updateHostGroup(id, input, ifMatch)),
    );
  }
  deleteHostGroup(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteHostGroup', { id, ifMatch }, () => {
      this.hosts.deleteHostGroup(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), deletedCount: 1 };
    });
  }
  createBookmarkGroup(
    key: string,
    input: CreateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'createBookmarkGroup', { input, ifMatch }, () => {
      const before = new Set(this.bookmarks.snapshot().groups.map((group) => group.id));
      const tree = this.bookmarks.createGroup(input, ifMatch);
      return {
        ids: tree.groups.filter((group) => !before.has(group.id)).map((group) => group.id),
        cursor: this.cursor(),
        treeRevision: tree.revision,
      };
    });
  }
  updateBookmarkGroup(
    key: string,
    id: string,
    input: UpdateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateBookmarkGroup', { id, input, ifMatch }, () => {
      const tree = this.bookmarks.updateGroup(id, input, ifMatch);
      return { ids: [id], cursor: this.cursor(), treeRevision: tree.revision };
    });
  }
  deleteBookmarkGroup(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteBookmarkGroup', { id, ifMatch }, () => {
      const tree = this.bookmarks.deleteGroup(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), treeRevision: tree.revision, deletedCount: 1 };
    });
  }
  createBookmark(
    key: string,
    input: CreateBookmarkInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'createBookmark', { input, ifMatch }, () => {
      const before = new Set(this.bookmarks.snapshot().bookmarks.map((bookmark) => bookmark.id));
      const tree = this.bookmarks.createBookmark(input, ifMatch);
      return {
        ids: tree.bookmarks
          .filter((bookmark) => !before.has(bookmark.id))
          .map((bookmark) => bookmark.id),
        cursor: this.cursor(),
        treeRevision: tree.revision,
      };
    });
  }
  updateBookmark(
    key: string,
    id: string,
    input: UpdateBookmarkInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateBookmark', { id, input, ifMatch }, () => {
      const tree =
        input.groupId === undefined
          ? this.bookmarks.updateBookmark(id, input, ifMatch)
          : this.bookmarks.updateBookmarkWithPlacement(id, input, ifMatch);
      return { ids: [id], cursor: this.cursor(), treeRevision: tree.revision };
    });
  }
  deleteBookmark(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteBookmark', { id, ifMatch }, () => {
      const tree = this.bookmarks.deleteBookmark(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), treeRevision: tree.revision, deletedCount: 1 };
    });
  }
  moveBookmarkTreeNode(
    key: string,
    input: MoveBookmarkTreeNodeInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'moveBookmarkTreeNode', { input, ifMatch }, () => {
      const tree = this.bookmarks.move(input, ifMatch);
      return { ids: [input.source.id], cursor: this.cursor(), treeRevision: tree.revision };
    });
  }
  createSshBookmark(
    key: string,
    input: CreateSshBookmarkInput,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'createSshBookmark', { input, ifMatch }, () => {
      const result = this.ssh.create(input, ifMatch);
      return {
        ids: [result.host.id, result.bookmark.id],
        cursor: this.cursor(),
        treeRevision: result.tree.revision,
        version: result.host.version,
      };
    });
  }
  updateSshBookmark(
    key: string,
    id: string,
    input: UpdateSshBookmarkInput,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateSshBookmark', { id, input, hostIfMatch, treeIfMatch }, () => {
      const result = this.ssh.updateBookmark(id, input, hostIfMatch, treeIfMatch);
      return {
        ids: [result.host.id, result.bookmark.id],
        cursor: this.cursor(),
        treeRevision: result.tree.revision,
        version: result.host.version,
      };
    });
  }
  deleteSshBookmark(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'deleteSshBookmark', { id, hostIfMatch, treeIfMatch }, () => {
      const result = this.ssh.deleteBookmark(id, hostIfMatch, treeIfMatch);
      return {
        ids: [id, ...(result.hostDeleted ? [result.hostId] : [])],
        cursor: this.cursor(),
        treeRevision: result.tree.revision,
        deletedCount: 1,
      };
    });
  }
  deleteSshBookmarkHost(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'deleteSshBookmarkHost', { id, hostIfMatch, treeIfMatch }, () => {
      const result = this.ssh.delete(id, hostIfMatch, treeIfMatch);
      return {
        ids: [id, ...result.bookmarkIds],
        cursor: this.cursor(),
        treeRevision: result.tree.revision,
        deletedCount: result.bookmarkIds.length,
      };
    });
  }
  createConnectionProfile(key: string, input: ConnectionProfileInput): CatalogReceipt {
    return this.write(key, 'createConnectionProfile', input, () =>
      this.entity(this.profiles.create(input)),
    );
  }
  updateConnectionProfile(
    key: string,
    id: string,
    input: ConnectionProfilePatch,
    ifMatch: string | undefined,
  ): CatalogReceipt {
    return this.write(key, 'updateConnectionProfile', { id, input, ifMatch }, () =>
      this.entity(this.profiles.update(id, input, ifMatch)),
    );
  }
  deleteConnectionProfile(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteConnectionProfile', { id, ifMatch }, () => {
      this.profiles.delete(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), deletedCount: 1 };
    });
  }
  deleteConnectionHistory(key: string, id: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'deleteConnectionHistory', { id, ifMatch }, () => {
      this.history.delete(id, ifMatch);
      return { ids: [id], cursor: this.cursor(), deletedCount: 1 };
    });
  }
  clearConnectionHistory(key: string, ifMatch: string | undefined): CatalogReceipt {
    return this.write(key, 'clearConnectionHistory', { ifMatch }, () => {
      const result = this.history.clear(ifMatch);
      return { ids: [], cursor: this.cursor(), deletedCount: result.deletedCount };
    });
  }
  listHosts(): Host[] {
    return this.hosts.listHosts();
  }
  listHostGroups(): HostGroup[] {
    return this.hosts.listHostGroups();
  }
  listConnectionHistory(query: ConnectionHistoryPageQuery) {
    return this.history.list(query);
  }
  private entity(entity: { id: string; version: number }): CatalogReceipt {
    return { ids: [entity.id], version: entity.version, cursor: this.cursor() };
  }
  private write(
    key: string,
    operation: string,
    input: unknown,
    apply: () => CatalogReceipt,
  ): CatalogReceipt {
    return this.work.transaction(() =>
      this.commands.execute(key, `catalog/${operation}`, input, apply),
    );
  }
}
