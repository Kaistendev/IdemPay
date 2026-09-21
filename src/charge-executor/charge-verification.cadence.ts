import type { BackoffConfig } from '../retry/backoff';
import { exponentialBackoffDelayMs } from '../retry/backoff';

export const DEFAULT_VERIFY_CADENCE_CONFIG: BackoffConfig = {
  baseDelayMs: 60_000,
  factor: 2,
  jitterRatio: 0.2,
  maxDelayMs: 3_600_000,
};

export const DEFAULT_MANUAL_REVIEW_THRESHOLD = 10;

export const DEFAULT_MANUAL_REVIEW_HOURS = 24;

export const MANUAL_REVIEW_WINDOW_MS = DEFAULT_MANUAL_REVIEW_HOURS * 3_600_000;

export function nextVerificationAt(
  now: Date,
  verificationNumber: number,
  config: BackoffConfig = DEFAULT_VERIFY_CADENCE_CONFIG,
  rand: () => number = Math.random,
): Date {
  return new Date(
    now.getTime() +
      exponentialBackoffDelayMs(verificationNumber - 1, config, rand),
  );
}
