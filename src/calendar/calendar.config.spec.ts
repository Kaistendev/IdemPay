import {
  DEFAULT_NON_BUSINESS_WEEKDAYS,
  readCalendarConfig,
} from './calendar.config';

describe('readCalendarConfig', () => {
  it('defaults to Saturday and Sunday', () => {
    expect(readCalendarConfig({})).toEqual({
      nonBusinessWeekdays: DEFAULT_NON_BUSINESS_WEEKDAYS,
    });
    expect(DEFAULT_NON_BUSINESS_WEEKDAYS).toEqual([0, 6]);
  });

  it('reads a configured weekend', () => {
    expect(
      readCalendarConfig({ CALENDAR_NON_BUSINESS_WEEKDAYS: '5, 6' }),
    ).toEqual({ nonBusinessWeekdays: [5, 6] });
  });

  it('removes duplicated weekdays', () => {
    expect(
      readCalendarConfig({ CALENDAR_NON_BUSINESS_WEEKDAYS: '0,6,0' }),
    ).toEqual({ nonBusinessWeekdays: [0, 6] });
  });

  it('allows removing the weekend entirely', () => {
    expect(readCalendarConfig({ CALENDAR_NON_BUSINESS_WEEKDAYS: ',' })).toEqual(
      { nonBusinessWeekdays: [] },
    );
  });

  it('rejects a weekday outside the 0..6 range', () => {
    expect(() =>
      readCalendarConfig({ CALENDAR_NON_BUSINESS_WEEKDAYS: '1,7' }),
    ).toThrow(/Invalid CALENDAR_NON_BUSINESS_WEEKDAYS/);
  });

  it('rejects a non-numeric weekday', () => {
    expect(() =>
      readCalendarConfig({ CALENDAR_NON_BUSINESS_WEEKDAYS: 'saturday' }),
    ).toThrow(/Invalid CALENDAR_NON_BUSINESS_WEEKDAYS/);
  });
});
