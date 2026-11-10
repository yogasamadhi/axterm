// Retained Axterm history promotion; fact ownership and compact receipts belong to Catalog.
import type {
  Host,
  PromoteConnectionHistoryInput,
  CatalogHistoryPromotionReceipt,
} from '@axterm/plugin-api/catalog';
import { promoteConnectionHistorySchema } from '@axterm/plugin-api/catalog';
import type { StorageCommandJournal } from '@axterm/plugin-api/storage';
import type { HostStore } from './ports/hosts.ts';
import type { CatalogHistory } from './ports/history.ts';
import type { UnitOfWork } from './ports/unit-of-work.ts';
import type { BookmarkTreeService } from './application/bookmark-tree-service.ts';
import { ApplicationError } from './application/errors.ts';
export class CatalogHistoryPromotion {
  constructor(
    private readonly work: UnitOfWork,
    private readonly commands: StorageCommandJournal,
    private readonly hosts: HostStore,
    private readonly bookmarks: BookmarkTreeService,
    private readonly history: CatalogHistory,
    private readonly cursor: () => number,
  ) {}
  promote(
    key: string,
    id: string,
    raw: PromoteConnectionHistoryInput,
    historyIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): CatalogHistoryPromotionReceipt {
    const input = promoteConnectionHistorySchema.parse(raw);
    return this.work.transaction(() =>
      this.commands.execute(
        key,
        'catalog/promoteConnectionHistory',
        { id, input, historyIfMatch, treeIfMatch },
        () => {
          const item = this.history.assertVersion(id, historyIfMatch);
          this.bookmarks.assertMutationTarget(input.groupId, treeIfMatch);
          let host: Host | undefined = item.hostId
            ? this.hosts.getHost(item.hostId)
            : this.hosts
                .listHosts()
                .find(
                  (candidate) =>
                    candidate.hostname.replace(/\.+$/, '').toLowerCase() ===
                      item.hostname.replace(/\.+$/, '').toLowerCase() &&
                    candidate.port === item.port &&
                    candidate.username === item.username &&
                    candidate.authType === item.authType &&
                    candidate.jumpHostId === item.jumpHostId &&
                    JSON.stringify(candidate.connectionOptions) ===
                      JSON.stringify(item.connectionOptions),
                );
          const createdHost = !host;
          host ??= this.hosts.createHost({
            groupId: null,
            name: this.uniqueName(item.name),
            hostname: item.hostname,
            port: item.port,
            username: item.username,
            authType: item.authType,
            credentialRef: null,
            passphraseCredentialRef: null,
            jumpHostId: item.jumpHostId,
            favorite: false,
            connectionOptions: item.connectionOptions,
          });
          const linked =
            item.hostId === host.id ? item : this.history.linkHost(id, host.id, historyIfMatch);
          const before = new Set(
            this.bookmarks.snapshot().bookmarks.map((bookmark) => bookmark.id),
          );
          const tree = this.bookmarks.createBookmark(
            {
              groupId: input.groupId,
              protocol: 'ssh',
              hostId: host.id,
              title: input.title ?? item.name,
              color: input.color,
              description: input.description,
              profileId: input.profileId,
            },
            treeIfMatch,
          );
          const bookmark = tree.bookmarks.find((bookmark) => !before.has(bookmark.id));
          if (!bookmark)
            throw new ApplicationError('INVALID_STATE', 'Promoted Bookmark is unavailable');
          return {
            ids: [id, host.id, bookmark.id],
            hostId: host.id,
            bookmarkId: bookmark.id,
            createdHost,
            historyVersion: linked.version,
            cursor: this.cursor(),
            treeRevision: tree.revision,
          };
        },
      ),
    );
  }
  private uniqueName(name: string): string {
    const base = name.trim().slice(0, 100) || 'SSH Host';
    const names = new Set(this.hosts.listHosts().map((host) => host.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let suffix = 2; suffix <= 10000; suffix++) {
      const ending = ` (${suffix})`;
      const candidate = base.slice(0, 100 - ending.length) + ending;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    throw new ApplicationError('CONFLICT', 'A unique Host name could not be allocated');
  }
}
