import type { SqlValue, SqlMutationResult } from '@axterm/plugin-api/storage';
export interface AiSql {
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[];
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined;
  run(sql: string, ...parameters: SqlValue[]): SqlMutationResult;
  transaction<T>(operation: () => T): T;
  appendEvent(type: string, entityId: string, payload: unknown): number;
}
