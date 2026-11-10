export class ApplicationError extends Error {
  constructor(
    readonly code:
      | 'VALIDATION_ERROR'
      | 'CAPABILITY_UNAVAILABLE'
      | 'REMOTE_EDIT_CONFLICT'
      | 'PAYLOAD_TOO_LARGE'
      | 'CONFLICT',
    message: string,
    readonly status: 400 | 409 | 413 | 503,
  ) {
    super(message);
  }
}
