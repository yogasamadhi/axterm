import type { SyncFailure } from '@axterm/plugin-api/configuration-sync';
export class SyncWorkflowError extends Error {
  constructor(readonly reason: SyncFailure) {
    super('SYNC_' + reason.toUpperCase().replaceAll('-', '_'));
  }
}
export type SyncApplicationErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_STATE'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'CAPACITY_EXCEEDED'
  | 'SYNC_NOT_CONFIGURED'
  | 'SYNC_FORMAT_UNSUPPORTED'
  | 'SYNC_REMOTE_CONFLICT'
  | 'SYNC_REMOTE_INVALID'
  | 'SYNC_PROVIDER_FAILED'
  | 'SYNC_GIST_CLONE_REQUIRED'
  | 'SYNC_GITEE_TRUNCATED'
  | 'SYNC_BACKUP_WRITE_FAILED'
  | 'SYNC_ABORTED';
export class SyncApplicationError extends Error {
  constructor(
    readonly code: SyncApplicationErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 412 | 413 | 428 | 503 = 409,
  ) {
    super(message);
  }
}
export function isSyncApplicationError(value: unknown): value is SyncApplicationError {
  return value instanceof SyncApplicationError;
}
