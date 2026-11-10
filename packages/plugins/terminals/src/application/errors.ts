export type ApplicationErrorCode =
  | 'PRECONDITION_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'
  | 'CAPACITY_EXCEEDED'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'REQUEST_CANCELED'
  | 'VALIDATION_ERROR';
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 412 | 413 | 428 | 503 = 409,
  ) {
    super(message);
  }
}
