export interface ErrorDetail {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface NormalizedError {
  readonly error: string;
  readonly message: string;
  readonly details?: readonly ErrorDetail[];
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function hasErrorCode(
  value: unknown,
): value is { error: string } & Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string' &&
    ERROR_CODE_PATTERN.test(value.error)
  );
}
