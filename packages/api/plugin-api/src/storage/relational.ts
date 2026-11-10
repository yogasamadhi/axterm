export type SqlValue = null | string | number | bigint | Uint8Array;
export interface SqlMutationResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}
export interface RelationalMigration {
  readonly version: number;
  readonly sql: string;
}
export interface RelationalDomainSpec {
  readonly kind: 'relational';
  readonly owner: string;
  readonly name: string;
  readonly version: number;
  readonly tables: readonly string[];
  readonly migrations: readonly RelationalMigration[];
}
declare const PARTICIPANT: unique symbol;
/** Opaque admission to a shared transaction; its owner retains the write handle. */
export interface RelationalParticipant {
  readonly [PARTICIPANT]: true;
}
export interface StorageOutboxEvent {
  readonly cursor: number;
  readonly domain: string;
  readonly type: string;
  readonly payload: unknown;
}
export interface RelationalDomain {
  readonly name: string;
  readonly participant: RelationalParticipant;
  all<T extends object>(sql: string, ...parameters: SqlValue[]): T[];
  get<T extends object>(sql: string, ...parameters: SqlValue[]): T | undefined;
  run(sql: string, ...parameters: SqlValue[]): SqlMutationResult;
  transaction<T>(operation: () => T): T;
  appendEvent(type: string, payload: unknown): number;
  /** Greatest persisted outbox cursor for this domain, including commits from another Profile. */
  cursor(): number;
  /** Retains 10,000 events per domain. If after predates pruning, returns [];
   * a changed cursor with no delta requires replacing the owner's baseline. */
  events(after: number, limit?: number): readonly StorageOutboxEvent[];
  /** Local after-commit wakeup; consumers also poll persisted cursors for cross-Profile writes. */
  subscribe(listener: (events: readonly StorageOutboxEvent[]) => void): () => void;
  close(): Promise<void>;
}
export interface RelationalFacet {
  open(spec: RelationalDomainSpec): Promise<RelationalDomain>;
  transaction<T>(participants: readonly RelationalParticipant[], operation: () => T): T;
  events(after: number, limit?: number): readonly StorageOutboxEvent[];
  subscribe(listener: (events: readonly StorageOutboxEvent[]) => void): () => void;
}
