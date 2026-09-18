export const IDEMPOTENCY_STORE = 'IDEMPOTENCY_STORE';
export const IDEMPOTENCY_KEY_PREFIX = 'idem:';
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_SECONDS * 1000;

export function idempotencyRecordKey(key: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${key}`;
}
