export type ApplicationErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_STATE'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'CAPACITY_EXCEEDED'
  | 'ATTACHMENT_EXPIRED'
  | 'HOST_KEY_REJECTED'
  | 'HOST_KEY_CHANGED'
  | 'AUTHENTICATION_FAILED'
  | 'FTP_CONNECTION_FAILED'
  | 'TELNET_CONNECTION_FAILED'
  | 'SERIAL_CONNECTION_FAILED'
  | 'PROXY_NOT_CONFIGURED'
  | 'PROXY_URL_INVALID'
  | 'PROXY_AUTH_INVALID'
  | 'PROXY_AUTH_REQUIRED'
  | 'PROXY_CONNECT_REJECTED'
  | 'PROXY_PROTOCOL_ERROR'
  | 'PROXY_RESPONSE_TOO_LARGE'
  | 'PROXY_TIMEOUT'
  | 'PROXY_ABORTED'
  | 'PROXY_CONNECT_FAILED'
  | 'PROXY_COMMAND_INVALID'
  | 'PROXY_COMMAND_START_FAILED'
  | 'PROXY_COMMAND_FAILED'
  | 'PROXY_COMMAND_TIMEOUT'
  | 'PROXY_COMMAND_ABORTED'
  | 'TRANSFER_FAILED'
  | 'SYNC_NOT_CONFIGURED'
  | 'SYNC_REMOTE_CONFLICT'
  | 'SYNC_REMOTE_INVALID'
  | 'SYNC_PROVIDER_FAILED'
  | 'SYNC_ABORTED'
  | 'AI_PROVIDER_FAILED'
  | 'AI_OUTPUT_INVALID'
  | 'REQUEST_CANCELED'
  | 'REMOTE_EDIT_CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED';

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 412 | 413 | 428 | 503 = 409,
  ) {
    super(message);
  }
}

const applicationErrorCodes: ReadonlySet<ApplicationErrorCode> = new Set([
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_REQUIRED',
  'PRECONDITION_FAILED',
  'CAPABILITY_UNAVAILABLE',
  'INVALID_STATE',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'CAPACITY_EXCEEDED',
  'ATTACHMENT_EXPIRED',
  'HOST_KEY_REJECTED',
  'HOST_KEY_CHANGED',
  'AUTHENTICATION_FAILED',
  'FTP_CONNECTION_FAILED',
  'TELNET_CONNECTION_FAILED',
  'PROXY_NOT_CONFIGURED',
  'PROXY_URL_INVALID',
  'PROXY_AUTH_INVALID',
  'PROXY_AUTH_REQUIRED',
  'PROXY_CONNECT_REJECTED',
  'PROXY_PROTOCOL_ERROR',
  'PROXY_RESPONSE_TOO_LARGE',
  'PROXY_TIMEOUT',
  'PROXY_ABORTED',
  'PROXY_CONNECT_FAILED',
  'PROXY_COMMAND_INVALID',
  'PROXY_COMMAND_START_FAILED',
  'PROXY_COMMAND_FAILED',
  'PROXY_COMMAND_TIMEOUT',
  'PROXY_COMMAND_ABORTED',
  'TRANSFER_FAILED',
  'SYNC_NOT_CONFIGURED',
  'SYNC_REMOTE_CONFLICT',
  'SYNC_REMOTE_INVALID',
  'SYNC_PROVIDER_FAILED',
  'SYNC_ABORTED',
  'AI_PROVIDER_FAILED',
  'AI_OUTPUT_INVALID',
  'REQUEST_CANCELED',
  'REMOTE_EDIT_CONFLICT',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
]);

/**
 * Production bundlers may materialize an application module more than once. Keep
 * typed REST failures intact across that boundary without accepting arbitrary
 * vendor errors: both the closed code set and the closed HTTP status set must match.
 */
export function isApplicationError(value: unknown): value is ApplicationError {
  if (value instanceof ApplicationError) return true;
  if (!(value instanceof Error) || !('code' in value) || !('status' in value)) return false;
  const candidate = value as Error & { code: unknown; status: unknown };
  return (
    typeof candidate.code === 'string' &&
    applicationErrorCodes.has(candidate.code as ApplicationErrorCode) &&
    [400, 404, 409, 412, 413, 428, 503].includes(candidate.status as number)
  );
}
