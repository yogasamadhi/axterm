export class ApplicationError extends Error {
  constructor(
    readonly code:
      | 'TRANSFER_FAILED'
      | 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE'
      | 'CAPABILITY_UNAVAILABLE'
      | 'VALIDATION_ERROR'
      | 'INVALID_STATE'
      | 'NOT_FOUND'
      | 'CAPACITY_EXCEEDED'
      | 'REQUEST_CANCELED',
    message: string,
    readonly status: 400 | 404 | 409 | 503 = 409,
  ) {
    super(message);
  }
}
