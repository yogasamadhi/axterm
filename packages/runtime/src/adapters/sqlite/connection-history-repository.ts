import { randomUUID } from 'node:crypto';
import {
  CONNECTION_HISTORY_MAX_ITEMS,
  connectionHistoryItemSchema,
  connectionHistoryPageQuerySchema,
  type ClearConnectionHistoryResult,
  type ConnectionHistoryItem,
  type ConnectionHistoryPage,
  type ConnectionHistoryPageQuery,
  type ConnectionHistoryState,
  type DeleteConnectionHistoryResult,
  type Host,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface ConnectionHistoryRow {
  id: string;
  target_key: string;
  host_id: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth_type: ConnectionHistoryItem['authType'];
  jump_host_id: string | null;
  connection_timeout_ms: number;
  keepalive_interval_ms: number;
  keepalive_count_max: number;
  compression: number;
  reconnect_mode: ConnectionHistoryItem['connectionOptions']['reconnectPolicy']['mode'];
  reconnect_delay_ms: number;
  reconnect_max_attempts: number;
  connection_count: number;
  last_connected_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface RecordConnectionHistoryInput {
  host: Host;
  persistedHostId: string | null;
}

interface HistoryCursor {
  version: 1;
  revision: number;
  sort: ConnectionHistoryPage['sort'];
  offset: number;
}

const rowToHistory = (row: ConnectionHistoryRow): ConnectionHistoryItem =>
  connectionHistoryItemSchema.parse({
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    jumpHostId: row.jump_host_id,
    connectionOptions: {
      connectionTimeoutMs: row.connection_timeout_ms,
      keepaliveIntervalMs: row.keepalive_interval_ms,
      keepaliveCountMax: row.keepalive_count_max,
      compression: row.compression === 1,
      reconnectPolicy: {
        mode: row.reconnect_mode,
        delayMs: row.reconnect_delay_ms,
        maxAttempts: row.reconnect_max_attempts,
      },
    },
    count: row.connection_count,
    lastConnectedAt: row.last_connected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });

export const connectionHistoryEtag = (revision: number): string =>
  `"connection-history-v${revision}"`;

/**
 * Persistence adapter for bounded, secret-free SSH connection history. Every
 * mutation advances one collection revision and appends its event in the same
 * SQLite transaction.
 */
export class ConnectionHistoryRepository {
  constructor(private readonly database: ProductDatabase) {}

  record(input: RecordConnectionHistoryInput): ConnectionHistoryItem {
    const key = connectionTargetKey(input.host);
    let result: ConnectionHistoryItem | undefined;
    this.database.transaction(() => {
      const current = this.database.get<ConnectionHistoryRow>(
        'SELECT * FROM recent_connections WHERE target_key=?',
        key,
      );
      const now = new Date().toISOString();
      if (current) {
        this.database.run(
          `UPDATE recent_connections
           SET host_id=?, name=?, hostname=?, port=?, username=?, auth_type=?, jump_host_id=?,
               connection_timeout_ms=?, keepalive_interval_ms=?, keepalive_count_max=?,
               compression=?, reconnect_mode=?, reconnect_delay_ms=?, reconnect_max_attempts=?,
               connection_count=connection_count+1, last_connected_at=?, updated_at=?,
               version=version+1
           WHERE id=? AND version=?`,
          input.persistedHostId,
          input.host.name,
          input.host.hostname,
          input.host.port,
          input.host.username,
          input.host.authType,
          input.host.jumpHostId,
          input.host.connectionOptions.connectionTimeoutMs,
          input.host.connectionOptions.keepaliveIntervalMs,
          input.host.connectionOptions.keepaliveCountMax,
          input.host.connectionOptions.compression ? 1 : 0,
          input.host.connectionOptions.reconnectPolicy.mode,
          input.host.connectionOptions.reconnectPolicy.delayMs,
          input.host.connectionOptions.reconnectPolicy.maxAttempts,
          now,
          now,
          current.id,
          current.version,
        );
        result = rowToHistory(this.requireRow(current.id));
      } else {
        const id = randomUUID();
        this.database.run(
          `INSERT INTO recent_connections(
             id, target_key, host_id, name, hostname, port, username, auth_type, jump_host_id,
             connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
             reconnect_mode, reconnect_delay_ms, reconnect_max_attempts, connection_count,
             last_connected_at, created_at, updated_at, version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
          id,
          key,
          input.persistedHostId,
          input.host.name,
          input.host.hostname,
          input.host.port,
          input.host.username,
          input.host.authType,
          input.host.jumpHostId,
          input.host.connectionOptions.connectionTimeoutMs,
          input.host.connectionOptions.keepaliveIntervalMs,
          input.host.connectionOptions.keepaliveCountMax,
          input.host.connectionOptions.compression ? 1 : 0,
          input.host.connectionOptions.reconnectPolicy.mode,
          input.host.connectionOptions.reconnectPolicy.delayMs,
          input.host.connectionOptions.reconnectPolicy.maxAttempts,
          now,
          now,
          now,
        );
        result = rowToHistory(this.requireRow(id));
      }

      const pruned = this.database
        .all<{ id: string }>(
          `SELECT id FROM recent_connections
           ORDER BY last_connected_at DESC, id
           LIMIT -1 OFFSET ?`,
          CONNECTION_HISTORY_MAX_ITEMS,
        )
        .map(({ id }) => id);
      for (const id of pruned) this.database.run('DELETE FROM recent_connections WHERE id=?', id);
      const revision = this.advanceRevision();
      this.database.appendEvent('connection-history.recorded', result.id, {
        item: result,
        prunedIds: pruned,
        historyRevision: revision,
      });
    });
    if (!result) throw new Error('Connection history transaction did not return an item');
    return result;
  }

  list(input: ConnectionHistoryPageQuery = {}): ConnectionHistoryPage {
    const command = connectionHistoryPageQuerySchema.parse(input);
    const state = this.state();
    const offset = command.cursor
      ? this.decodeCursor(command.cursor, state.revision, command.sort)
      : 0;
    const ordering =
      command.sort === 'frequency'
        ? 'connection_count DESC, last_connected_at DESC, id'
        : 'last_connected_at DESC, id';
    const total =
      this.database.get<{ count: number }>('SELECT COUNT(*) AS count FROM recent_connections')
        ?.count ?? 0;
    const items = this.database
      .all<ConnectionHistoryRow>(
        `SELECT * FROM recent_connections ORDER BY ${ordering} LIMIT ? OFFSET ?`,
        command.limit,
        offset,
      )
      .map(rowToHistory);
    const nextOffset = offset + items.length;
    return {
      ...state,
      sort: command.sort,
      limit: command.limit,
      total,
      items,
      nextCursor:
        nextOffset < total
          ? this.encodeCursor({
              version: 1,
              revision: state.revision,
              sort: command.sort,
              offset: nextOffset,
            })
          : null,
    };
  }

  get(id: string): ConnectionHistoryItem {
    return rowToHistory(this.requireRow(id));
  }

  assertVersion(id: string, ifMatch: string | undefined): ConnectionHistoryItem {
    const current = this.get(id);
    if (current.version !== entityVersionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Connection history item changed', 412);
    return current;
  }

  linkHost(id: string, hostId: string, ifMatch: string | undefined): ConnectionHistoryItem {
    let result: ConnectionHistoryItem | undefined;
    this.database.transaction(() => {
      const current = this.assertVersion(id, ifMatch);
      if (current.hostId === hostId) {
        result = current;
        return;
      }
      const now = new Date().toISOString();
      const updated = this.database.run(
        `UPDATE recent_connections SET host_id=?, updated_at=?, version=version+1
         WHERE id=? AND version=?`,
        hostId,
        now,
        id,
        current.version,
      );
      if (!updated.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Connection history item changed', 412);
      result = rowToHistory(this.requireRow(id));
      const revision = this.advanceRevision();
      this.database.appendEvent('connection-history.linked', id, {
        id,
        hostId,
        historyRevision: revision,
      });
    });
    if (!result) throw new Error('Connection history link transaction did not return an item');
    return result;
  }

  delete(id: string, ifMatch: string | undefined): DeleteConnectionHistoryResult {
    let result: DeleteConnectionHistoryResult | undefined;
    this.database.transaction(() => {
      const current = this.assertVersion(id, ifMatch);
      const deleted = this.database.run(
        'DELETE FROM recent_connections WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!deleted.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Connection history item changed', 412);
      const revision = this.advanceRevision();
      this.database.appendEvent('connection-history.deleted', id, {
        id,
        historyRevision: revision,
      });
      result = { id, revision, etag: connectionHistoryEtag(revision) };
    });
    if (!result) throw new Error('Connection history delete transaction did not return a result');
    return result;
  }

  clear(ifMatch: string | undefined): ClearConnectionHistoryResult {
    let result: ClearConnectionHistoryResult | undefined;
    this.database.transaction(() => {
      const currentRevision = this.requireRevision(ifMatch);
      const deletedCount = Number(this.database.run('DELETE FROM recent_connections').changes);
      if (!deletedCount) {
        result = {
          deletedCount,
          revision: currentRevision,
          etag: connectionHistoryEtag(currentRevision),
        };
        return;
      }
      const revision = this.advanceRevision();
      this.database.appendEvent('connection-history.cleared', 'connection-history', {
        deletedCount,
        historyRevision: revision,
      });
      result = { deletedCount, revision, etag: connectionHistoryEtag(revision) };
    });
    if (!result) throw new Error('Connection history clear transaction did not return a result');
    return result;
  }

  state(): ConnectionHistoryState {
    const revision = this.readRevision();
    return { revision, etag: connectionHistoryEtag(revision) };
  }

  private readRevision(): number {
    const value = this.database.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='connection-history:revision'",
    )?.value;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new ApplicationError('INVALID_STATE', 'Connection history revision is unavailable');
    return revision;
  }

  private requireRevision(ifMatch: string | undefined): number {
    if (!ifMatch)
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Connection history If-Match is required',
        428,
      );
    const match = /^"connection-history-v(\d+)"$/.exec(ifMatch);
    if (!match)
      throw new ApplicationError('PRECONDITION_FAILED', 'Invalid connection history version', 412);
    const expected = Number(match[1]);
    const current = this.readRevision();
    if (expected !== current)
      throw new ApplicationError('PRECONDITION_FAILED', 'Connection history changed', 412);
    return current;
  }

  private advanceRevision(): number {
    const updated = this.database.run(
      `UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       WHERE key='connection-history:revision'`,
    );
    if (!updated.changes)
      throw new ApplicationError('INVALID_STATE', 'Connection history revision is unavailable');
    return this.readRevision();
  }

  private requireRow(id: string): ConnectionHistoryRow {
    const row = this.database.get<ConnectionHistoryRow>(
      'SELECT * FROM recent_connections WHERE id=?',
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'Connection history item not found', 404);
    return row;
  }

  private encodeCursor(cursor: HistoryCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(
    value: string,
    revision: number,
    sort: ConnectionHistoryPage['sort'],
  ): number {
    try {
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<HistoryCursor>;
      if (
        decoded.version !== 1 ||
        decoded.revision !== revision ||
        decoded.sort !== sort ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset! < 1 ||
        decoded.offset! > CONNECTION_HISTORY_MAX_ITEMS
      )
        throw new Error('invalid cursor');
      return decoded.offset!;
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Connection history cursor is invalid or expired',
        412,
      );
    }
  }
}

export function connectionTargetKey(host: Host): string {
  return JSON.stringify([
    host.hostname.replace(/\.+$/, '').toLowerCase(),
    host.port,
    host.username,
  ]);
}

function entityVersionFromEtag(value: string | undefined): number {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match)
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Invalid connection history item version',
      412,
    );
  return Number(match[1]);
}
