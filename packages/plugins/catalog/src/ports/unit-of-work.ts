/**
 * Synchronous transaction boundary used by application workflows that update
 * more than one aggregate. The SQLite adapter implements this port, while the
 * application layer remains independent from SQLite APIs.
 */
export interface UnitOfWork {
  transaction<T>(operation: () => T): T;
}
