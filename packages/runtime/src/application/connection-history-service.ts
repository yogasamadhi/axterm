import {
  clearConnectionHistoryResultSchema,
  connectionHistoryPageQuerySchema,
  deleteConnectionHistoryResultSchema,
  promoteConnectionHistoryResultSchema,
  promoteConnectionHistorySchema,
  reconnectConnectionHistoryResultSchema,
  reconnectConnectionHistorySchema,
  type ClearConnectionHistoryResult,
  type ConnectionHistoryPage,
  type ConnectionHistoryPageQuery,
  type DeleteConnectionHistoryResult,
  type Host,
  type PromoteConnectionHistoryInput,
  type PromoteConnectionHistoryResult,
  type ReconnectConnectionHistoryInput,
  type ReconnectConnectionHistoryResult,
} from '@workspace/contracts';
import type { ConnectionHistoryRepository } from '../adapters/sqlite/connection-history-repository';
import type { ProductRepository } from '../adapters/sqlite/product-repository';
import { stableHash } from '../adapters/sqlite/product-repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { ConnectionHistoryRecorder, ConnectionStarter } from '../ports/connection-history';
import type { BookmarkTreeService } from './bookmark-tree-service';
import { ApplicationError } from './errors';

/** Coordinates connection history with live connections and the Host/Bookmark aggregate. */
export class ConnectionHistoryService implements ConnectionHistoryRecorder {
  private readonly reconnectReceipts = new Map<
    string,
    { requestHash: string; result: ReconnectConnectionHistoryResult }
  >();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly history: ConnectionHistoryRepository,
    private readonly hosts: ProductRepository,
    private readonly bookmarks: BookmarkTreeService,
  ) {}

  recordSuccessful(input: { host: Host; persistedHostId: string | null }): void {
    if (!this.hosts.getSettings().privacy.connectionHistoryEnabled) return;
    this.history.record(input);
  }

  list(input: ConnectionHistoryPageQuery = {}): ConnectionHistoryPage {
    return this.history.list(connectionHistoryPageQuerySchema.parse(input));
  }

  delete(
    id: string,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
  ): DeleteConnectionHistoryResult {
    const key = requireIdempotencyKey(idempotencyKey);
    const request = { id, ifMatch };
    const previous = this.hosts.resolveIdempotency<DeleteConnectionHistoryResult>(
      key,
      'connection-history.delete',
      request,
    );
    if (previous) return deleteConnectionHistoryResultSchema.parse(previous);

    let result: DeleteConnectionHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      result = this.history.delete(id, ifMatch);
      this.hosts.recordIdempotency(key, 'connection-history.delete', request, result);
    });
    if (!result) throw new Error('Connection history delete workflow did not return a result');
    return result;
  }

  clear(
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
  ): ClearConnectionHistoryResult {
    const key = requireIdempotencyKey(idempotencyKey);
    const request = { ifMatch };
    const previous = this.hosts.resolveIdempotency<ClearConnectionHistoryResult>(
      key,
      'connection-history.clear',
      request,
    );
    if (previous) return clearConnectionHistoryResultSchema.parse(previous);

    let result: ClearConnectionHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      result = this.history.clear(ifMatch);
      this.hosts.recordIdempotency(key, 'connection-history.clear', request, result);
    });
    if (!result) throw new Error('Connection history clear workflow did not return a result');
    return result;
  }

  reconnect(
    id: string,
    input: ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
    idempotencyKey: string | undefined,
    connections: ConnectionStarter,
  ): ReconnectConnectionHistoryResult {
    const command = reconnectConnectionHistorySchema.parse(input);
    const key = requireIdempotencyKey(idempotencyKey);
    const requestHash = stableHash({ id, input: command, ifMatch });
    const previous = this.reconnectReceipts.get(key);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new ApplicationError(
          'CONFLICT',
          'Idempotency key was reused with different input',
          409,
        );
      return reconnectConnectionHistoryResultSchema.parse(previous.result);
    }
    const item = this.history.assertVersion(id, ifMatch);
    let connection;
    if (item.hostId) {
      // Reconnect through the authoritative Host so current credentials and jump
      // settings are used without copying either into history.
      this.hosts.getHost(item.hostId);
      const connectionProfileId = this.bookmarks
        .snapshot()
        .bookmarks.find((bookmark) => bookmark.hostId === item.hostId)?.connectionProfileId;
      connection = connections.create({
        hostId: item.hostId,
        ...(connectionProfileId ? { connectionProfileId } : {}),
        ...(command.temporarySecret ? { temporarySecret: command.temporarySecret } : {}),
        ...(command.temporaryPassphrase
          ? { temporaryPassphrase: command.temporaryPassphrase }
          : {}),
      });
    } else {
      if (item.jumpHostId)
        throw new ApplicationError(
          'CONFLICT',
          'This history item requires a saved jump-host target',
          409,
        );
      connection = connections.create({
        target: {
          name: item.name,
          hostname: item.hostname,
          port: item.port,
          username: item.username,
          authType: item.authType,
          connectionOptions: item.connectionOptions,
        },
        ...(command.temporarySecret ? { temporarySecret: command.temporarySecret } : {}),
        ...(command.temporaryPassphrase
          ? { temporaryPassphrase: command.temporaryPassphrase }
          : {}),
      });
    }
    const result = reconnectConnectionHistoryResultSchema.parse({ connection, historyItem: item });
    this.reconnectReceipts.set(key, { requestHash, result });
    if (this.reconnectReceipts.size > 128)
      this.reconnectReceipts.delete(this.reconnectReceipts.keys().next().value!);
    return result;
  }

  promote(
    id: string,
    input: PromoteConnectionHistoryInput,
    historyIfMatch: string | undefined,
    treeIfMatch: string | undefined,
    idempotencyKey: string | undefined,
  ): PromoteConnectionHistoryResult {
    const command = promoteConnectionHistorySchema.parse(input);
    const key = requireIdempotencyKey(idempotencyKey);
    const request = { id, input: command, historyIfMatch, treeIfMatch };
    const previous = this.hosts.resolveIdempotency<PromoteConnectionHistoryResult>(
      key,
      'connection-history.promote',
      request,
    );
    if (previous) return promoteConnectionHistoryResultSchema.parse(previous);

    let result: PromoteConnectionHistoryResult | undefined;
    this.unitOfWork.transaction(() => {
      const item = this.history.assertVersion(id, historyIfMatch);
      this.bookmarks.assertMutationTarget(command.groupId, treeIfMatch);
      let host = item.hostId ? this.hosts.getHost(item.hostId) : this.findCompatibleHost(item);
      const createdHost = !host;
      host ??= this.hosts.createHost({
        groupId: null,
        name: this.uniqueHostName(item.name),
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

      const historyItem =
        item.hostId === host.id ? item : this.history.linkHost(id, host.id, historyIfMatch);
      const beforeIds = new Set(this.bookmarks.snapshot().bookmarks.map(({ id }) => id));
      const tree = this.bookmarks.createBookmark(
        {
          groupId: command.groupId,
          protocol: 'ssh',
          hostId: host.id,
          title: command.title ?? item.name,
          color: command.color,
          description: command.description,
          profileId: command.profileId,
        },
        treeIfMatch,
      );
      const bookmark = tree.bookmarks.find(({ id: bookmarkId }) => !beforeIds.has(bookmarkId));
      if (!bookmark)
        throw new ApplicationError('INVALID_STATE', 'Promoted Bookmark is missing from tree');
      result = promoteConnectionHistoryResultSchema.parse({
        historyItem,
        history: this.history.state(),
        host,
        bookmark,
        tree,
        createdHost,
      });
      this.hosts.recordIdempotency(key, 'connection-history.promote', request, result);
    });
    if (!result) throw new Error('Connection history promotion did not return a result');
    return result;
  }

  private findCompatibleHost(
    item: ReturnType<ConnectionHistoryRepository['get']>,
  ): Host | undefined {
    return this.hosts
      .listHosts()
      .find(
        (host) =>
          host.hostname.replace(/\.+$/, '').toLowerCase() ===
            item.hostname.replace(/\.+$/, '').toLowerCase() &&
          host.port === item.port &&
          host.username === item.username &&
          host.authType === item.authType &&
          host.jumpHostId === item.jumpHostId &&
          JSON.stringify(host.connectionOptions) === JSON.stringify(item.connectionOptions),
      );
  }

  private uniqueHostName(value: string): string {
    const base = value.trim().slice(0, 100) || 'SSH Host';
    const names = new Set(this.hosts.listHosts().map(({ name }) => name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let suffix = 2; suffix <= 10_000; suffix += 1) {
      const ending = ` (${suffix})`;
      const candidate = `${base.slice(0, 100 - ending.length)}${ending}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    throw new ApplicationError('CONFLICT', 'A unique Host name could not be allocated', 409);
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  if (!value)
    throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
  if (value.length > 200)
    throw new ApplicationError('PRECONDITION_FAILED', 'Idempotency-Key is invalid', 412);
  return value;
}
