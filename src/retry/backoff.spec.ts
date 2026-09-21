import {
  DEFAULT_BACKOFF_CONFIG,
  exponentialBackoffDelayMs,
  nextBackoffAttemptAt,
} from './backoff';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('exponentialBackoffDelayMs', () => {
  it('keeps the four automatic waits in their ±20% range', () => {
    const nominals = [10_000, 20_000, 40_000, 80_000];

    for (let retryIndex = 0; retryIndex < nominals.length; retryIndex += 1) {
      const nominal = nominals[retryIndex];
      for (let sample = 0; sample < 100; sample += 1) {
        const delay = exponentialBackoffDelayMs(retryIndex);
        expect(delay).toBeGreaterThanOrEqual(nominal * 0.8);
        expect(delay).toBeLessThanOrEqual(nominal * 1.2);
      }
    }
  });

  it('reaches the exact lower and upper jitter bounds for every wait', () => {
    const nominals = [10_000, 20_000, 40_000, 80_000];

    for (let retryIndex = 0; retryIndex < nominals.length; retryIndex += 1) {
      const nominal = nominals[retryIndex];
      expect(
        exponentialBackoffDelayMs(retryIndex, DEFAULT_BACKOFF_CONFIG, () => 0),
      ).toBeCloseTo(nominal * 0.8, 6);
      expect(
        exponentialBackoffDelayMs(retryIndex, DEFAULT_BACKOFF_CONFIG, () => 1),
      ).toBeCloseTo(nominal * 1.2, 6);
    }
  });

  it('caps the delay at one hour even when the exponential grows beyond it', () => {
    for (let retryIndex = 9; retryIndex < 12; retryIndex += 1) {
      const delay = exponentialBackoffDelayMs(
        retryIndex,
        DEFAULT_BACKOFF_CONFIG,
        () => 1,
      );
      expect(delay).toBe(DEFAULT_BACKOFF_CONFIG.maxDelayMs);
      expect(delay).toBe(3_600_000);
    }
  });

  it('never exceeds the maximum delay with a random source', () => {
    for (let retryIndex = 0; retryIndex < 20; retryIndex += 1) {
      const delay = exponentialBackoffDelayMs(retryIndex);
      expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF_CONFIG.maxDelayMs);
    }
  });

  it('honours a custom base, factor and maximum delay', () => {
    const first = exponentialBackoffDelayMs(
      0,
      { baseDelayMs: 5_000, factor: 3, jitterRatio: 0, maxDelayMs: 60_000 },
      () => 0.5,
    );
    const second = exponentialBackoffDelayMs(
      1,
      { baseDelayMs: 5_000, factor: 3, jitterRatio: 0, maxDelayMs: 60_000 },
      () => 0.5,
    );

    expect(first).toBe(5_000);
    expect(second).toBe(15_000);
  });
});

describe('nextBackoffAttemptAt', () => {
  it('schedules the next attempt from an injectable clock', () => {
    const next = nextBackoffAttemptAt(
      NOW,
      0,
      DEFAULT_BACKOFF_CONFIG,
      () => 0.5,
    );

    expect(next).toEqual(new Date('2026-01-01T00:00:10Z'));
  });

  it('schedules the fourth wait eighty seconds after the clock, jittered', () => {
    const low = nextBackoffAttemptAt(NOW, 3, DEFAULT_BACKOFF_CONFIG, () => 0);
    const high = nextBackoffAttemptAt(NOW, 3, DEFAULT_BACKOFF_CONFIG, () => 1);

    expect(low).toEqual(new Date('2026-01-01T00:01:04Z'));
    expect(high).toEqual(new Date('2026-01-01T00:01:36Z'));
  });
});
