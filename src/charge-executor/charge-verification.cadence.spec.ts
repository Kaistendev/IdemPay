import {
  DEFAULT_MANUAL_REVIEW_THRESHOLD,
  DEFAULT_VERIFY_CADENCE_CONFIG,
  nextVerificationAt,
  MANUAL_REVIEW_WINDOW_MS,
} from './charge-verification.cadence';

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

describe('nextVerificationAt', () => {
  it('starts at one minute and doubles on each verification step', () => {
    expect(
      nextVerificationAt(
        FIXED_NOW,
        1,
        DEFAULT_VERIFY_CADENCE_CONFIG,
        () => 0.5,
      ),
    ).toEqual(new Date('2026-01-01T00:01:00Z'));
    expect(
      nextVerificationAt(
        FIXED_NOW,
        2,
        DEFAULT_VERIFY_CADENCE_CONFIG,
        () => 0.5,
      ),
    ).toEqual(new Date('2026-01-01T00:02:00Z'));
    expect(
      nextVerificationAt(
        FIXED_NOW,
        3,
        DEFAULT_VERIFY_CADENCE_CONFIG,
        () => 0.5,
      ),
    ).toEqual(new Date('2026-01-01T00:04:00Z'));
  });

  it('caps the cadence window at one hour', () => {
    const far = nextVerificationAt(
      FIXED_NOW,
      12,
      DEFAULT_VERIFY_CADENCE_CONFIG,
      () => 0.5,
    );
    expect(far.getTime()).toBe(FIXED_NOW.getTime() + 3_600_000);
  });

  it('applies the jitter around the nominal delay', () => {
    const low = nextVerificationAt(
      FIXED_NOW,
      1,
      DEFAULT_VERIFY_CADENCE_CONFIG,
      () => 0,
    );
    const high = nextVerificationAt(
      FIXED_NOW,
      1,
      DEFAULT_VERIFY_CADENCE_CONFIG,
      () => 1,
    );
    expect(low.getTime()).toBe(FIXED_NOW.getTime() + 48_000);
    expect(high.getTime()).toBe(FIXED_NOW.getTime() + 72_000);
  });
});

describe('manual review thresholds', () => {
  it('triggers after ten verifications', () => {
    expect(DEFAULT_MANUAL_REVIEW_THRESHOLD).toBe(10);
  });

  it('triggers after twenty-four hours since the unknown state', () => {
    expect(MANUAL_REVIEW_WINDOW_MS).toBe(24 * 3_600_000);
  });
});
