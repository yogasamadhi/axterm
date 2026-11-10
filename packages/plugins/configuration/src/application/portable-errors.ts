export type PortableApplicationErrorCode =
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'INVALID_STATE'
  | 'VALIDATION_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'CAPACITY_EXCEEDED'
  | 'ATTACHMENT_EXPIRED'
  | 'AXTERM_CONFIGURATION_WRITE_FAILED'
  | 'CLOSED';
export class PortableApplicationError extends Error {
  constructor(
    readonly code: PortableApplicationErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 412 | 413 | 428 | 503 = 409,
  ) {
    super(message);
  }
}
