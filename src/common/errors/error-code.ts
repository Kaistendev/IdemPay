export const ErrorCode = {
  ValidationError: 'VALIDATION_ERROR',
  BadRequest: 'BAD_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  Locked: 'LOCKED',
  InternalError: 'INTERNAL_ERROR',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  IdempotencyKeyRequired: 'IDEMPOTENCY_KEY_REQUIRED',
  IdempotencyKeyTooLong: 'IDEMPOTENCY_KEY_TOO_LONG',
  IdempotencyPayloadMismatch: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  IdempotencyLocked: 'IDEMPOTENCY_LOCKED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.BadRequest,
  401: ErrorCode.Unauthorized,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  423: ErrorCode.Locked,
  500: ErrorCode.InternalError,
  503: ErrorCode.ServiceUnavailable,
};

export function errorCodeForStatus(status: number): string {
  return STATUS_TO_ERROR_CODE[status] ?? `HTTP_${status}`;
}
