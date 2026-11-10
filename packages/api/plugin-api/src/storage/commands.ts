export type StorageCommandErrorCode =
  'invalid-input' | 'conflict' | 'receipt-expired' | 'invalid-result' | 'corrupt-receipt';
/** Stable command diagnostics never retain payloads or arbitrary callback failures. */
export class StorageCommandError extends Error {
  override readonly name = 'StorageCommandError';
  constructor(readonly code: StorageCommandErrorCode) {
    super(`STORAGE_COMMAND_${code.toUpperCase().replaceAll('-', '_')}`);
  }
}
export interface StorageCommandJournal {
  /** Synchronous fact changes, outbox and receipt commit together; outcome must be compact JSON. */
  execute<T>(id: string, operation: string, input: unknown, apply: () => T): T;
}
