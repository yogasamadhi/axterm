import { createHash, randomUUID } from 'node:crypto';
import {
  COMMAND_HISTORY_MAX_ITEMS,
  clearCommandHistoryResultSchema,
  commandHistoryItemSchema,
  commandHistoryPageQuerySchema,
  deleteCommandHistoryResultSchema,
  type ClearCommandHistoryResult,
  type CommandHistoryItem,
  type CommandHistoryPage,
  type CommandHistoryPageQuery,
  type CommandHistoryState,
  type DeleteCommandHistoryResult,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface CommandHistoryRow {
  id: string;
  command_text: string;
  use_count: number;
  last_used_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface CommandHistoryCursor {
  version: 1;
  revision: number;
  sort: CommandHistoryPage['sort'];
  searchHash: string;
  offset: number;
}

const rowToItem = (row: CommandHistoryRow): CommandHistoryItem =>
  commandHistoryItemSchema.parse({
    id: row.id,
    command: row.command_text,
    count: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });

export const commandHistoryEtag = (revision: number): string => `"command-history-v${revision}"`;

/**
 * SQLite persistence for exact-command aggregates. Event payloads contain IDs
 * and counters only, so clearing history removes every persisted command body.
 */
export class CommandHistoryRepository {
  constructor(private readonly database: ProductDatabase) {}

  record(command: string): CommandHistoryItem {
    let result: CommandHistoryItem | undefined;
    this.database.transaction(() => {
      const current = this.database.get<CommandHistoryRow>(
        'SELECT * FROM command_history WHERE command_text=?',
        command,
      );
      const now = new Date().toISOString();
      if (current) {
        const updated = this.database.run(
          `UPDATE command_history
             SET use_count=use_count+1, last_used_at=?, updated_at=?, version=version+1
           WHERE id=? AND version=?`,
          now,
          now,
          current.id,
          current.version,
        );
        if (!updated.changes)
          throw new ApplicationError('PRECONDITION_FAILED', 'Command history item changed', 412);
        result = rowToItem(this.requireRow(current.id));
      } else {
        const id = randomUUID();
        this.database.run(
          `INSERT INTO command_history(
             id, command_text, use_count, last_used_at, created_at, updated_at, version
           ) VALUES (?, ?, 1, ?, ?, ?, 1)`,
          id,
          command,
          now,
          now,
          now,
        );
        result = rowToItem(this.requireRow(id));
      }

      const prunedIds = this.database
        .all<{ id: string }>(
          `SELECT id FROM command_history
             ORDER BY last_used_at DESC, id
             LIMIT -1 OFFSET ?`,
          COMMAND_HISTORY_MAX_ITEMS,
        )
        .map(({ id }) => id);
      for (const id of prunedIds) this.database.run('DELETE FROM command_history WHERE id=?', id);

      const revision = this.advanceRevision();
      this.database.appendEvent('command-history.recorded', result.id, {
        id: result.id,
        count: result.count,
        prunedIds,
        historyRevision: revision,
      });
    });
    if (!result) throw new Error('Command history transaction did not return an item');
    return result;
  }

  list(input: CommandHistoryPageQuery = {}): CommandHistoryPage {
    const query = commandHistoryPageQuerySchema.parse(input);
    const search = query.search ?? '';
    const state = this.state();
    const offset = query.cursor
      ? this.decodeCursor(query.cursor, state.revision, query.sort, search)
      : 0;
    const ordering =
      query.sort === 'frequency'
        ? 'use_count DESC, last_used_at DESC, id'
        : 'last_used_at DESC, id';
    const pattern = `%${escapeLike(search)}%`;
    const where = search ? "WHERE lower(command_text) LIKE lower(?) ESCAPE '\\'" : '';
    const parameters = search ? [pattern] : [];
    const total =
      this.database.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM command_history ${where}`,
        ...parameters,
      )?.count ?? 0;
    const items = this.database
      .all<CommandHistoryRow>(
        `SELECT * FROM command_history ${where} ORDER BY ${ordering} LIMIT ? OFFSET ?`,
        ...parameters,
        query.limit,
        offset,
      )
      .map(rowToItem);
    const nextOffset = offset + items.length;
    return {
      ...state,
      sort: query.sort,
      search,
      limit: query.limit,
      total,
      items,
      nextCursor:
        nextOffset < total
          ? this.encodeCursor({
              version: 1,
              revision: state.revision,
              sort: query.sort,
              searchHash: hashSearch(search),
              offset: nextOffset,
            })
          : null,
    };
  }

  get(id: string): CommandHistoryItem {
    return rowToItem(this.requireRow(id));
  }

  delete(id: string, ifMatch: string | undefined): DeleteCommandHistoryResult {
    let result: DeleteCommandHistoryResult | undefined;
    this.database.transaction(() => {
      const current = this.get(id);
      if (current.version !== entityVersionFromEtag(ifMatch))
        throw new ApplicationError('PRECONDITION_FAILED', 'Command history item changed', 412);
      const deleted = this.database.run(
        'DELETE FROM command_history WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!deleted.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Command history item changed', 412);
      const revision = this.advanceRevision();
      this.database.appendEvent('command-history.deleted', id, {
        id,
        historyRevision: revision,
      });
      result = deleteCommandHistoryResultSchema.parse({
        id,
        revision,
        etag: commandHistoryEtag(revision),
      });
    });
    if (!result) throw new Error('Command history delete transaction did not return a result');
    return result;
  }

  clear(ifMatch: string | undefined): ClearCommandHistoryResult {
    let result: ClearCommandHistoryResult | undefined;
    this.database.transaction(() => {
      const currentRevision = this.requireRevision(ifMatch);
      const deletedCount = Number(this.database.run('DELETE FROM command_history').changes);
      if (!deletedCount) {
        result = clearCommandHistoryResultSchema.parse({
          deletedCount,
          revision: currentRevision,
          etag: commandHistoryEtag(currentRevision),
        });
        return;
      }
      const revision = this.advanceRevision();
      this.database.appendEvent('command-history.cleared', 'command-history', {
        deletedCount,
        historyRevision: revision,
      });
      result = clearCommandHistoryResultSchema.parse({
        deletedCount,
        revision,
        etag: commandHistoryEtag(revision),
      });
    });
    if (!result) throw new Error('Command history clear transaction did not return a result');
    return result;
  }

  state(): CommandHistoryState {
    const revision = this.readRevision();
    return { revision, etag: commandHistoryEtag(revision) };
  }

  private requireRow(id: string): CommandHistoryRow {
    const row = this.database.get<CommandHistoryRow>(
      'SELECT * FROM command_history WHERE id=?',
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'Command history item not found', 404);
    return row;
  }

  private readRevision(): number {
    const value = this.database.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='command-history:revision'",
    )?.value;
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 1)
      throw new ApplicationError('INVALID_STATE', 'Command history revision is unavailable');
    return revision;
  }

  private requireRevision(ifMatch: string | undefined): number {
    if (!ifMatch)
      throw new ApplicationError(
        'PRECONDITION_REQUIRED',
        'Command history If-Match is required',
        428,
      );
    const match = /^"command-history-v(\d+)"$/.exec(ifMatch);
    if (!match)
      throw new ApplicationError('PRECONDITION_FAILED', 'Invalid command history version', 412);
    const expected = Number(match[1]);
    const current = this.readRevision();
    if (expected !== current)
      throw new ApplicationError('PRECONDITION_FAILED', 'Command history changed', 412);
    return current;
  }

  private advanceRevision(): number {
    const updated = this.database.run(
      `UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       WHERE key='command-history:revision'`,
    );
    if (!updated.changes)
      throw new ApplicationError('INVALID_STATE', 'Command history revision is unavailable');
    return this.readRevision();
  }

  private encodeCursor(cursor: CommandHistoryCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(
    value: string,
    revision: number,
    sort: CommandHistoryPage['sort'],
    search: string,
  ): number {
    try {
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<CommandHistoryCursor>;
      if (
        decoded.version !== 1 ||
        decoded.revision !== revision ||
        decoded.sort !== sort ||
        decoded.searchHash !== hashSearch(search) ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset! < 1 ||
        decoded.offset! > COMMAND_HISTORY_MAX_ITEMS
      )
        throw new Error('invalid cursor');
      return decoded.offset!;
    } catch {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        'Command history cursor is invalid or expired',
        412,
      );
    }
  }
}

function hashSearch(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function entityVersionFromEtag(value: string | undefined): number {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match)
    throw new ApplicationError('PRECONDITION_FAILED', 'Invalid command history item version', 412);
  return Number(match[1]);
}
