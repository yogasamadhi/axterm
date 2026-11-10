import type { SqlValue, SqlMutationResult } from '@axterm/plugin-api/storage';
/** Owned relational port used only by the Automation adapters. */
export interface AutomationSql {
  assertBounds(): void;
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[];
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined;
  run(sql: string, ...parameters: SqlValue[]): SqlMutationResult;
  transaction<T>(apply: () => T): T;
  appendEvent(type: string, entityId: string, payload: unknown): number;
}
