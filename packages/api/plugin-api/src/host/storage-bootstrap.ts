import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite';
/** Revocable migration port; native database and prepared statement objects stay private. */
export interface StorageMigrationStatement {
  all(...parameters: SQLInputValue[]): Record<string, unknown>[];
  get(...parameters: SQLInputValue[]): Record<string, unknown> | undefined;
  run(...parameters: SQLInputValue[]): StatementResultingChanges;
}
export interface StorageMigrationConnection {
  exec(sql: string): void;
  prepare(sql: string): StorageMigrationStatement;
}
/** Immutable product schema input consumed by the generic SQLite provider. */
export interface StorageBootstrapMigration {
  readonly id: number;
  readonly risky: boolean;
  readonly sql: string;
  readonly apply?: (connection: StorageMigrationConnection) => void;
}
export interface StorageTableOwner {
  readonly table: string;
  readonly domain: string;
  readonly owner: string;
}
export interface StorageBootstrapPlan {
  readonly generation: 2;
  readonly migrations: readonly StorageBootstrapMigration[];
  readonly tables: readonly StorageTableOwner[];
}
