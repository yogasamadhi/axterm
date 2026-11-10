import { randomUUID } from 'node:crypto';
import {
  Remote,
  RemoteError,
  remoteErrorOf,
  StorageCommandError,
  TypertRemoteService,
} from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import { ZodError } from 'zod';
import * as Contract from '@axterm/plugin-api/catalog';
import { productDomains } from '@axterm/data-schema';
import { DomainCommands } from '@axterm/infra-storage-domain';
import { CatalogStorage } from './adapters/catalog-storage.ts';
import { HostRepository } from './adapters/host-repository.ts';
import { BookmarkRepository } from './adapters/bookmark-repository.ts';
import { ConnectionProfileRepository } from './adapters/connection-profile-repository.ts';
import { ConnectionHistoryRepository } from './adapters/connection-history-repository.ts';
import { CatalogApplication } from './application/catalog.ts';
import { BookmarkTreeService } from './application/bookmark-tree-service.ts';
import { ConnectionProfileService } from './application/connection-profile-service.ts';
import { SshBookmarkService } from './application/ssh-bookmark-service.ts';
import { ApplicationError } from './application/errors.ts';
import { CatalogReferenceRegistry } from './references.ts';
import { CatalogObservation } from './observation.ts';
import { CatalogImports } from './imports.ts';
import { CatalogHistoryPromotion } from './history-promotion.ts';
import { HostImportService } from './application/host-import-service.ts';
import { GrantedConfigSources } from './adapters/config-sources.ts';

export const inject = ['storage', 'storageDomain', 'runtimeIdentity'];
declare module '@deepseek-ai/cordis' {
  interface Context {
    catalogController: CatalogController;
  }
}

/** Generated Remote boundary. Product mutations stay in the Catalog application owner. */
export class CatalogController extends TypertRemoteService {
  private open = true;
  constructor(
    ctx: Context,
    private readonly application: CatalogApplication,
    private readonly observation: CatalogObservation,
    private readonly imports: CatalogImports,
    private readonly promotion: CatalogHistoryPromotion,
  ) {
    super(ctx, 'catalogController', { namespace: 'catalog' });
    ctx.effect(() => async () => {
      this.open = false;
      const results = await Promise.allSettled([
        this.observation.dispose(),
        this.imports.dispose(),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('CATALOG_DRAIN_FAILED');
    });
  }
  @Remote({ mode: 'stream' }) watchCatalog(
    signal: AbortSignal,
  ): AsyncIterable<Contract.CatalogUpdate> {
    return this.call(() => this.observation.watch(signal));
  }
  @Remote listHosts(): Contract.Host[] {
    return this.call(() => this.application.listHosts());
  }
  @Remote listHostGroups(): Contract.HostGroup[] {
    return this.call(() => this.application.listHostGroups());
  }
  @Remote({ resources: { host: (id: string) => id } }) getHost(id: string): Contract.Host {
    return this.call(() => this.application.hosts.getHost(Contract.idSchema.parse(id)));
  }
  @Remote getBookmarkTree(): Contract.BookmarkTree {
    return this.call(() => this.application.bookmarks.snapshot());
  }
  @Remote({ resources: { bookmark: (id: string) => id } }) getBookmark(
    id: string,
  ): Contract.Bookmark {
    return this.call(() => this.application.bookmarks.getBookmark(Contract.idSchema.parse(id)));
  }
  @Remote listConnectionProfiles(): Contract.ConnectionProfile[] {
    return this.call(() => this.application.profiles.list());
  }
  @Remote({ resources: { connectionProfile: (id: string) => id } }) getConnectionProfile(
    id: string,
  ): Contract.ConnectionProfile {
    return this.call(() => this.application.profiles.get(Contract.idSchema.parse(id)));
  }
  @Remote listConnectionHistory(
    generation: string,
    query: Contract.CatalogHistoryQuery,
  ): Contract.ConnectionHistoryPage {
    if (generation !== this.ctx.runtimeIdentity.generation)
      throw new RemoteError('catalog/failure', 'Catalog generation changed', { reason: 'stale' });
    return this.call(() =>
      this.application.listConnectionHistory(
        Contract.connectionHistoryPageQuerySchema.parse(query),
      ),
    );
  }
  @Remote({ resources: { connectionHistory: (id: string) => id } })
  getConnectionHistoryItem(
    id: string,
    ifMatch: string | undefined,
  ): Contract.ConnectionHistoryItem {
    return this.call(() =>
      this.application.history.assertVersion(Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote createHost(key: string, input: Contract.CreateHostInput): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.createHost(key, Contract.createHostSchema.parse(input)),
    );
  }
  @Remote({ resources: { host: (key: string, id: string) => id } }) updateHost(
    key: string,
    id: string,
    input: Contract.UpdateHostInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.updateHost(
        key,
        Contract.idSchema.parse(id),
        Contract.updateHostSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { host: (key: string, id: string) => id } }) deleteHost(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() => this.application.deleteHost(key, Contract.idSchema.parse(id), ifMatch));
  }
  @Remote createHostGroup(
    key: string,
    input: Contract.CreateHostGroupInput,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.createHostGroup(key, Contract.createHostGroupSchema.parse(input)),
    );
  }
  @Remote({ resources: { hostGroup: (key: string, id: string) => id } }) updateHostGroup(
    key: string,
    id: string,
    input: Contract.UpdateHostGroupInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.updateHostGroup(
        key,
        Contract.idSchema.parse(id),
        Contract.updateHostGroupSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { hostGroup: (key: string, id: string) => id } }) deleteHostGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteHostGroup(key, Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote createBookmarkGroup(
    key: string,
    input: Contract.CreateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.createBookmarkGroup(
        key,
        Contract.createBookmarkGroupSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { bookmarkGroup: (key: string, id: string) => id } }) updateBookmarkGroup(
    key: string,
    id: string,
    input: Contract.UpdateBookmarkGroupInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.updateBookmarkGroup(
        key,
        Contract.idSchema.parse(id),
        Contract.updateBookmarkGroupSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { bookmarkGroup: (key: string, id: string) => id } }) deleteBookmarkGroup(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteBookmarkGroup(key, Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote createBookmark(
    key: string,
    input: Contract.CreateBookmarkInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.createBookmark(key, Contract.createBookmarkSchema.parse(input), ifMatch),
    );
  }
  @Remote({ resources: { bookmark: (key: string, id: string) => id } }) updateBookmark(
    key: string,
    id: string,
    input: Contract.UpdateBookmarkInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.updateBookmark(
        key,
        Contract.idSchema.parse(id),
        Contract.updateBookmarkSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { bookmark: (key: string, id: string) => id } }) deleteBookmark(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteBookmark(key, Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote moveBookmarkTreeNode(
    key: string,
    input: Contract.MoveBookmarkTreeNodeInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.moveBookmarkTreeNode(
        key,
        Contract.moveBookmarkTreeNodeSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote createSshBookmark(
    key: string,
    input: Contract.CreateSshBookmarkInput,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(
      () =>
        this.application.createSshBookmark(
          key,
          Contract.createSshBookmarkSchema.parse(input),
          ifMatch,
        ),
      key,
    );
  }
  @Remote updateSshBookmark(
    key: string,
    id: string,
    input: Contract.UpdateSshBookmarkInput,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(
      () =>
        this.application.updateSshBookmark(
          key,
          Contract.idSchema.parse(id),
          Contract.updateSshBookmarkSchema.parse(input),
          hostIfMatch,
          treeIfMatch,
        ),
      key,
    );
  }
  @Remote deleteSshBookmark(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteSshBookmark(
        key,
        Contract.idSchema.parse(id),
        hostIfMatch,
        treeIfMatch,
      ),
    );
  }
  @Remote deleteSshBookmarkHost(
    key: string,
    id: string,
    hostIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteSshBookmarkHost(
        key,
        Contract.idSchema.parse(id),
        hostIfMatch,
        treeIfMatch,
      ),
    );
  }
  @Remote createConnectionProfile(
    key: string,
    input: Contract.ConnectionProfileInput,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.createConnectionProfile(
        key,
        Contract.connectionProfileInputSchema.parse(input),
      ),
    );
  }
  @Remote({ resources: { connectionProfile: (key: string, id: string) => id } })
  updateConnectionProfile(
    key: string,
    id: string,
    input: Contract.ConnectionProfilePatch,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.updateConnectionProfile(
        key,
        Contract.idSchema.parse(id),
        Contract.connectionProfilePatchSchema.parse(input),
        ifMatch,
      ),
    );
  }
  @Remote({ resources: { connectionProfile: (key: string, id: string) => id } })
  deleteConnectionProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteConnectionProfile(key, Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote({ resources: { connectionHistory: (key: string, id: string) => id } })
  deleteConnectionHistory(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() =>
      this.application.deleteConnectionHistory(key, Contract.idSchema.parse(id), ifMatch),
    );
  }
  @Remote clearConnectionHistory(
    key: string,
    ifMatch: string | undefined,
  ): Contract.CatalogReceipt {
    return this.call(() => this.application.clearConnectionHistory(key, ifMatch));
  }
  @Remote({
    mode: 'stream',
    resources: {
      fileGrant: (input: Contract.PreviewSshConfigImportInput) => [
        input.grantId,
        ...(input.includeGrants ?? []).map((item) => item.grantId),
      ],
    },
  })
  previewSshConfigImport(
    input: Contract.PreviewSshConfigImportInput,
    signal: AbortSignal,
  ): AsyncIterable<Contract.CatalogImportChunk> {
    return this.importStream(() =>
      this.imports.preview(Contract.previewSshConfigImportSchema.parse(input), signal),
    );
  }
  @Remote commitSshConfigImport(
    key: string,
    input: Contract.CommitSshConfigImportInput,
    treeIfMatch: string | undefined,
  ): Contract.CatalogImportReceipt {
    return this.call(() =>
      this.imports.commit(key, Contract.commitSshConfigImportSchema.parse(input), treeIfMatch),
    );
  }
  @Remote({ mode: 'stream', resources: { catalogImportReport: (id: string) => id } })
  getSshConfigImportReport(
    id: string,
    signal: AbortSignal,
  ): AsyncIterable<Contract.CatalogImportChunk> {
    return this.importStream(() => this.imports.report(Contract.idSchema.parse(id), signal));
  }
  @Remote({ resources: { connectionHistory: (_key: string, id: string) => id } })
  promoteConnectionHistoryToBookmark(
    key: string,
    id: string,
    input: Contract.PromoteConnectionHistoryInput,
    historyIfMatch: string | undefined,
    treeIfMatch: string | undefined,
  ): Contract.CatalogHistoryPromotionReceipt {
    return this.call(() =>
      this.promotion.promote(
        key,
        Contract.idSchema.parse(id),
        Contract.promoteConnectionHistorySchema.parse(input),
        historyIfMatch,
        treeIfMatch,
      ),
    );
  }
  private async *importStream(
    open: () => AsyncIterable<Contract.CatalogImportChunk>,
  ): AsyncGenerator<Contract.CatalogImportChunk> {
    try {
      for await (const item of this.call(open)) yield item;
    } catch (error) {
      this.call(() => {
        throw error;
      });
    }
  }
  private call<T>(apply: () => T, operationId?: string): T {
    if (!this.open)
      throw new RemoteError('catalog/failure', 'Catalog is closed', { reason: 'closed' });
    try {
      return apply();
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (marked?.code === 'catalog/failure') throw marked;
      let reason: Contract.CatalogFailureReason = 'unavailable';
      if (error instanceof ApplicationError) {
        const reasons: Record<string, Contract.CatalogFailureReason> = {
          NOT_FOUND: 'not-found',
          CONFLICT: 'conflict',
          HOST_NAME_CONFLICT: 'conflict',
          PRECONDITION_REQUIRED: 'precondition-required',
          PRECONDITION_FAILED: 'precondition-failed',
          CAPABILITY_UNAVAILABLE: 'unavailable',
          CAPACITY_EXCEEDED: 'capacity',
        };
        reason = reasons[error.code] ?? 'invalid-input';
      } else if (error instanceof ZodError) reason = 'invalid-input';
      else if (error instanceof StorageCommandError)
        reason =
          error.code === 'receipt-expired'
            ? 'receipt-expired'
            : error.code === 'conflict'
              ? 'conflict'
              : 'invalid-input';
      const code = Contract.sshDiagnosticCodeSchema.safeParse(
        error instanceof ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof ApplicationError
            ? error.code
            : undefined,
      );
      const fields =
        error instanceof ZodError
          ? [
              ...new Set(
                error.issues.flatMap((issue) => {
                  const path = issue.path.slice(0, 2).join('.');
                  const known = Contract.sshDiagnosticFieldSchema.safeParse(path);
                  return known.success ? [known.data] : [];
                }),
              ),
            ].slice(0, 8)
          : undefined;
      const identity = Contract.idSchema.safeParse(operationId);
      throw new RemoteError('catalog/failure', 'The catalog operation failed', {
        reason,
        ...(code.success
          ? {
              diagnostic: Contract.sshOperationDiagnosticSchema.parse({
                code: code.data,
                ...(fields?.length ? { fields } : {}),
                ...(identity.success ? { operationId: identity.data } : {}),
              }),
            }
          : {}),
      });
    }
  }
}

export async function apply(ctx: Context): Promise<void> {
  const opening = ctx.storage.domain.open(productDomains.catalog);
  ctx.effect(() => async () => {
    await (await opening.catch(() => undefined))?.close();
  });
  const domain = await opening;
  const references = new CatalogReferenceRegistry(ctx);
  const work = {
    transaction: <T>(apply: () => T): T =>
      ctx.storage.domain.transaction([domain.participant, ...references.participants()], apply),
  };
  const storage = new CatalogStorage(domain);
  const hosts = new HostRepository(storage, (id) => references.retainedBy(id));
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(storage));
  const profiles = new ConnectionProfileService(new ConnectionProfileRepository(storage));
  const history = new ConnectionHistoryRepository(storage);
  const ssh = new SshBookmarkService(work, hosts, bookmarks);
  const commands = new DomainCommands(domain, 'axterm_catalog_command_receipts');
  const application = new CatalogApplication(
    work,
    commands,
    hosts,
    bookmarks,
    profiles,
    ssh,
    history,
    () => domain.cursor(),
  );
  const observation = new CatalogObservation(domain, () => ({
    generation: ctx.runtimeIdentity.generation,
    cursor: domain.cursor(),
    hosts: application.listHosts(),
    hostGroups: application.listHostGroups(),
    bookmarks: bookmarks.snapshot(),
    connectionProfiles: profiles.list(),
    history: application.listConnectionHistory({ sort: 'recent', limit: 50 }),
  }));
  const sources = new GrantedConfigSources(() => {
    const files = ctx.get('files');
    const grants = ctx.get('fileGrants');
    if (!files || !grants)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    return { files, grants };
  });
  const imports = new CatalogImports(
    new HostImportService(sources, work, hosts, bookmarks),
    sources,
    work,
    commands,
    storage,
    () => domain.cursor(),
  );
  const promotion = new CatalogHistoryPromotion(work, commands, hosts, bookmarks, history, () =>
    domain.cursor(),
  );
  const controller = new CatalogController(ctx, application, observation, imports, promotion);
  ctx.provide('catalog', {
    participant: domain.participant,
    configurationImport: {
      hosts: {
        createHostGroup(input) {
          const receipt = controller.createHostGroup(randomUUID(), input);
          const created = controller.listHostGroups().find((item) => item.id === receipt.ids[0]);
          if (!created) throw new Error('CONFIGURATION_CATALOG_CREATE_FAILED');
          return created;
        },
        createHost(input) {
          const receipt = controller.createHost(randomUUID(), input);
          return controller.getHost(receipt.ids[0]!);
        },
      },
      bookmarks: {
        snapshot: () => controller.getBookmarkTree(),
        createGroup(input, ifMatch) {
          controller.createBookmarkGroup(randomUUID(), input, ifMatch);
          return controller.getBookmarkTree();
        },
        createBookmark(input, ifMatch) {
          controller.createBookmark(randomUUID(), input, ifMatch);
          return controller.getBookmarkTree();
        },
      },
      profiles: {
        list: () => controller.listConnectionProfiles(),
        create(input) {
          const receipt = controller.createConnectionProfile(randomUUID(), input);
          return controller.getConnectionProfile(receipt.ids[0]!);
        },
      },
    },
    listHosts: () => controller.listHosts(),
    getHost: (id) => controller.getHost(id),
    getConnectionHistoryItem: (id, ifMatch) => controller.getConnectionHistoryItem(id, ifMatch),
    listHostGroups: () => controller.listHostGroups(),
    getBookmarkTree: () => controller.getBookmarkTree(),
    getBookmark: (id) => controller.getBookmark(id),
    listConnectionProfiles: () => controller.listConnectionProfiles(),
    getConnectionProfile: (id) => controller.getConnectionProfile(id),
  });
  // Optional workflow participation is a child scope, not a Catalog activation dependency.
  ctx.inject(['configurationHistory'], (scope) => {
    const release = scope.configurationHistory.register('connection-history', {
      participant: domain.participant,
      purge: () => history.clear(history.state().etag),
    });
    scope.effect(() => release);
  });
  ctx.inject(['configuration'], (scope) => {
    scope.provide('catalogConnectionHistory', {
      recordSuccessful: (input) =>
        ctx.storage.domain.transaction(
          [domain.participant, scope.configuration.participant],
          () => {
            if (scope.configuration.getSettings().privacy.connectionHistoryEnabled)
              history.record(input);
          },
        ),
    });
  });
}
