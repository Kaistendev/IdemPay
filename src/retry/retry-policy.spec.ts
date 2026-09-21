import { decideRetry, DEFAULT_MAX_RETRIES } from './retry-policy';

describe('decideRetry', () => {
  it('schedules a RETRY_PENDING after any retryable failure before the last attempt', () => {
    for (let attemptNo = 1; attemptNo < DEFAULT_MAX_RETRIES; attemptNo += 1) {
      expect(decideRetry('PROVIDER_ERROR', attemptNo)).toBe('RETRY_PENDING');
      expect(decideRetry('TEMPORARY_UNAVAILABLE', attemptNo)).toBe(
        'RETRY_PENDING',
      );
    }
  });

  it('never retries after the fifth attempt', () => {
    expect(decideRetry('PROVIDER_ERROR', 5)).toBe('FAILED_FINAL');
    expect(decideRetry('TEMPORARY_UNAVAILABLE', 5)).toBe('FAILED_FINAL');
  });

  it('does not retry a declined payment on any attempt', () => {
    for (let attemptNo = 1; attemptNo <= DEFAULT_MAX_RETRIES; attemptNo += 1) {
      expect(decideRetry('DECLINED', attemptNo)).toBe('FAILED_FINAL');
    }
  });

  it('does not retry any non-retryable error', () => {
    for (const errorType of [
      'DECLINED',
      'INVALID_PAYMENT',
      'INVALID_AMOUNT',
      'CANCELLED_SUBSCRIPTION',
    ] as const) {
      expect(decideRetry(errorType, 2)).toBe('FAILED_FINAL');
    }
  });

  it('may retry an ambiguous error once its no-charge result is verified', () => {
    expect(decideRetry('TIMEOUT', 2)).toBe('RETRY_PENDING');
  });

  it('honours a custom retry budget', () => {
    expect(decideRetry('PROVIDER_ERROR', 3, 3)).toBe('FAILED_FINAL');
    expect(decideRetry('PROVIDER_ERROR', 2, 3)).toBe('RETRY_PENDING');
  });
});
