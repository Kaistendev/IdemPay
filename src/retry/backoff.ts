export interface BackoffConfig {
  baseDelayMs: number;
  factor: number;
  jitterRatio: number;
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 10_000,
  factor: 2,
  jitterRatio: 0.2,
  maxDelayMs: 3_600_000,
};

export function exponentialBackoffDelayMs(
  retryIndex: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  rand: () => number = Math.random,
): number {
  const nominal = config.baseDelayMs * Math.pow(config.factor, retryIndex);
  const jittered =
    nominal * (1 - config.jitterRatio + 2 * config.jitterRatio * rand());
  return Math.min(jittered, config.maxDelayMs);
}

export function nextBackoffAttemptAt(
  now: Date,
  retryIndex: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  rand: () => number = Math.random,
): Date {
  return new Date(
    now.getTime() + exponentialBackoffDelayMs(retryIndex, config, rand),
  );
}
