import {
  DEFAULT_VERIFICATION_SWEEP_INTERVAL_MS,
  readVerificationSweepIntervalMs,
} from './charge-verification.interval';

describe('readVerificationSweepIntervalMs', () => {
  it('defaults to five seconds', () => {
    expect(readVerificationSweepIntervalMs({})).toBe(
      DEFAULT_VERIFICATION_SWEEP_INTERVAL_MS,
    );
    expect(DEFAULT_VERIFICATION_SWEEP_INTERVAL_MS).toBe(5_000);
  });

  it('reads a configured interval', () => {
    expect(
      readVerificationSweepIntervalMs({
        VERIFICATION_SWEEP_INTERVAL_MS: '1500',
      }),
    ).toBe(1500);
  });

  it('rejects a non-numeric interval', () => {
    expect(() =>
      readVerificationSweepIntervalMs({
        VERIFICATION_SWEEP_INTERVAL_MS: 'soon',
      }),
    ).toThrow(/Invalid VERIFICATION_SWEEP_INTERVAL_MS/);
  });

  it('rejects a zero or negative interval', () => {
    expect(() =>
      readVerificationSweepIntervalMs({ VERIFICATION_SWEEP_INTERVAL_MS: '0' }),
    ).toThrow(/Invalid VERIFICATION_SWEEP_INTERVAL_MS/);
    expect(() =>
      readVerificationSweepIntervalMs({ VERIFICATION_SWEEP_INTERVAL_MS: '-1' }),
    ).toThrow(/Invalid VERIFICATION_SWEEP_INTERVAL_MS/);
  });
});
