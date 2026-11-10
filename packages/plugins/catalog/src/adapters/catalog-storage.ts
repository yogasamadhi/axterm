import type { RelationalDomain, SqlValue } from '@axterm/plugin-api/storage';
import type { CatalogSql } from '../ports/catalog-sql.ts';
/** Adapts the existing SQL statements to the owner's ctx.storage handle, never a native connection. */
export class CatalogStorage implements CatalogSql {
  constructor(private readonly domain: RelationalDomain) {}
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[] {
    return this.domain.all<T>(sql, ...parameters);
  }
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined {
    return this.domain.get<T>(sql, ...parameters);
  }
  run(sql: string, ...parameters: SqlValue[]) {
    return this.domain.run(sql, ...parameters);
  }
  transaction<T>(apply: () => T): T {
    return this.domain.transaction(apply);
  }
  appendEvent(type: string, entityId: string, payload: unknown): number {
    return this.domain.appendEvent(type, { entityId, payload });
  }
}
