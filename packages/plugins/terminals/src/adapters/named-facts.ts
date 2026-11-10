import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../application/errors.ts';
import type { TerminalFactsSql } from '../ports/facts-sql.ts';
type JsonTable = 'terminal_profiles' | 'terminal_themes';
interface JsonRow {
  id: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}
const versionFromEtag = (value: string | undefined): number => {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match) throw new ApplicationError('PRECONDITION_FAILED', 'Invalid entity version', 412);
  return Number(match[1]);
};
export class NamedTerminalFacts {
  constructor(private readonly database: TerminalFactsSql) {}
  listJson<T>(table: JsonTable): T[] {
    return this.database
      .all<JsonRow>(`SELECT * FROM ${table} ORDER BY name`)
      .map((row) => this.jsonFromRow<T>(row));
  }

  getJson<T>(table: JsonTable, id: string): T {
    const row = this.database.get<JsonRow>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Resource not found', 404);
    return this.jsonFromRow<T>(row);
  }

  createJson<T extends { name: string }>(
    table: JsonTable,
    input: T,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const now = new Date().toISOString();
    const entity = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, version: 1 };
    this.database.transaction(() => {
      this.database.run(
        'INSERT INTO ' +
          table +
          '(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
        entity.id,
        input.name,
        JSON.stringify(input),
        now,
        now,
      );
      this.database.appendEvent(`${eventType}.created`, entity.id, entity);
    });
    return entity;
  }

  updateJson<T extends { name: string }>(
    table: JsonTable,
    id: string,
    input: { [K in keyof T]?: T[K] | undefined },
    ifMatch: string | undefined,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const current = this.getJson<
      T & { id: string; createdAt: string; updatedAt: string; version: number }
    >(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      id,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    } as T & { id: string; createdAt: string; updatedAt: string; version: number };
    const payload = { ...next };
    delete (payload as Partial<typeof next>).id;
    delete (payload as Partial<typeof next>).createdAt;
    delete (payload as Partial<typeof next>).updatedAt;
    delete (payload as Partial<typeof next>).version;
    this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE ${table} SET name=?, payload=?, updated_at=?, version=? WHERE id=? AND version=?`,
        next.name,
        JSON.stringify(payload),
        next.updatedAt,
        next.version,
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
      this.database.appendEvent(`${eventType}.updated`, id, next);
    });
    return next;
  }

  deleteJson(table: JsonTable, id: string, ifMatch: string | undefined, eventType: string): void {
    const current = this.getJson<{ id: string; version: number }>(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table} WHERE id=? AND version=?`, id, current.version);
      this.database.appendEvent(`${eventType}.deleted`, id, { id });
    });
  }

  replaceJsonCollection<
    T extends {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      version: number;
    },
  >(table: JsonTable, values: readonly T[], eventType: string): void {
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table}`);
      for (const value of values) {
        const payload = { ...value } as Record<string, unknown>;
        delete payload.id;
        delete payload.createdAt;
        delete payload.updatedAt;
        delete payload.version;
        this.database.run(
          `INSERT INTO ${table}(id, name, payload, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?)`,
          value.id,
          value.name,
          JSON.stringify(payload),
          value.createdAt,
          value.updatedAt,
          value.version,
        );
      }
      this.database.appendEvent(`${eventType}.replaced`, eventType, { count: values.length });
    });
  }

  private jsonFromRow<T>(row: JsonRow): T {
    return {
      ...JSON.parse(row.payload),
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    } as T;
  }
}
