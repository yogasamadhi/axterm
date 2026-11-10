// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/storage/storage/src/error.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Error vocabulary for the storage hub and its backends.
 * @module @axterm/infra-storage/src/error
 */

/** Discriminant codes carried by every {@link StorageError}. */
export type StorageErrorCode =
  | 'backend-not-found'
  | 'form-not-mounted'
  | 'duplicate-backend'
  | 'duplicate-mount'
  | 'version-mismatch'
  | 'malformed-medium'
  | 'unknown-state'
  | 'closed'
  | 'ownership-conflict'
  | 'unit-in-use';

/**
 * Error thrown by the hub and by backend implementations. The `code` is the
 * stable contract consumers may switch on; `message` is diagnostic prose.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError';

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options (`cause`).
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
