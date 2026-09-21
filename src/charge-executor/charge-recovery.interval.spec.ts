import {
  DEFAULT_RECOVERY_SWEEP_INTERVAL_MS,
  readRecoverySweepIntervalMs,
} from './charge-recovery.interval';

describe('readRecoverySweepIntervalMs', () => {
  it('defaults to thirty seconds', () => {
    expect(readRecoverySweepIntervalMs({})).toBe(
      DEFAULT_RECOVERY_SWEEP_INTERVAL_MS,
    );
    expect(DEFAULT_RECOVERY_SWEEP_INTERVAL_MS).toBe(30_000);
  });

  it('reads a configured interval', () => {
    expect(
      readRecoverySweepIntervalMs({ RECOVERY_SWEEP_INTERVAL_MS: '1500' }),
    ).toBe(1500);
  });

  it('rejects a non-numeric interval', () => {
    expect(() =>
      readRecoverySweepIntervalMs({ RECOVERY_SWEEP_INTERVAL_MS: 'soon' }),
    ).toThrow(/Invalid RECOVERY_SWEEP_INTERVAL_MS/);
  });

  it('rejects a zero or negative interval', () => {
    expect(() =>
      readRecoverySweepIntervalMs({ RECOVERY_SWEEP_INTERVAL_MS: '0' }),
    ).toThrow(/Invalid RECOVERY_SWEEP_INTERVAL_MS/);
    expect(() =>
      readRecoverySweepIntervalMs({ RECOVERY_SWEEP_INTERVAL_MS: '-1' }),
    ).toThrow(/Invalid RECOVERY_SWEEP_INTERVAL_MS/);
  });
});
