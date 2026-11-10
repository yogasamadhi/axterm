import type { RelationalDomain, SqlValue } from '@axterm/plugin-api/storage';
import type { AiSql } from '../ports/sql.ts';
export class AiStorage implements AiSql {
  constructor(readonly domain: RelationalDomain) {}
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[] {
    return this.domain.all<T>(sql, ...parameters);
  }
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined {
    return this.domain.get<T>(sql, ...parameters);
  }
  run(sql: string, ...parameters: SqlValue[]) {
    return this.domain.run(sql, ...parameters);
  }
  transaction<T>(operation: () => T): T {
    return this.domain.transaction(operation);
  }
  appendEvent(type: string, entityId: string, payload: unknown): number {
    return this.domain.appendEvent(type, { entityId, payload });
  }
}
