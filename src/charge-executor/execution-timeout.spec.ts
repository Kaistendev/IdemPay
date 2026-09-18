import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  readExecutionTimeoutMs,
} from './execution-timeout';

describe('readExecutionTimeoutMs', () => {
  it('defaults to one minute', () => {
    expect(readExecutionTimeoutMs({})).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
    expect(DEFAULT_EXECUTION_TIMEOUT_MS).toBe(60_000);
  });

  it('reads a configured timeout', () => {
    expect(readExecutionTimeoutMs({ EXECUTION_TIMEOUT_MS: '1500' })).toBe(1500);
  });

  it('rejects a non-numeric timeout', () => {
    expect(() =>
      readExecutionTimeoutMs({ EXECUTION_TIMEOUT_MS: 'soon' }),
    ).toThrow(/Invalid EXECUTION_TIMEOUT_MS/);
  });

  it('rejects a negative timeout', () => {
    expect(() =>
      readExecutionTimeoutMs({ EXECUTION_TIMEOUT_MS: '-1' }),
    ).toThrow(/Invalid EXECUTION_TIMEOUT_MS/);
  });
});
