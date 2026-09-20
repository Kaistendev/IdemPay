export const IDEMPOTENCY_KEY_LOCK = 'IDEMPOTENCY_KEY_LOCK';
export const IDEMPOTENCY_KEY_PREFIX = 'idem:';
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const IDEMPOTENCY_TTL_MS = IDEMPOTENCY_TTL_SECONDS * 1000;
export const IDEMPOTENCY_LEASE_SECONDS = 5 * 60;
export const IDEMPOTENCY_LEASE_MS = IDEMPOTENCY_LEASE_SECONDS * 1000;
export const IDEMPOTENCY_LOCK_MS = 2000;

export function idempotencyLockKey(key: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}lock:${key}`;
}
