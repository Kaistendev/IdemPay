import {
  DEFAULT_SCHEDULING_TIMEZONE,
  readSchedulingTimeZone,
} from './scheduling-timezone';

describe('readSchedulingTimeZone', () => {
  it('falls back to the default when the variable is unset', () => {
    expect(readSchedulingTimeZone({})).toBe(DEFAULT_SCHEDULING_TIMEZONE);
  });

  it('falls back to the default when the variable is blank', () => {
    expect(readSchedulingTimeZone({ SCHEDULING_TIMEZONE: '   ' })).toBe(
      DEFAULT_SCHEDULING_TIMEZONE,
    );
  });

  it('returns the configured zone', () => {
    expect(
      readSchedulingTimeZone({
        SCHEDULING_TIMEZONE: 'America/Argentina/Buenos_Aires',
      }),
    ).toBe('America/Argentina/Buenos_Aires');
  });

  it('rejects an unsupported zone', () => {
    expect(() =>
      readSchedulingTimeZone({ SCHEDULING_TIMEZONE: 'Mars/Olympus' }),
    ).toThrow('Invalid time zone');
  });
});
