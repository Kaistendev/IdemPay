import {
  currentCycleDate,
  cycleDateAt,
  daysInMonth,
  isBusinessDay,
  isOverdueByTolerance,
  nextBusinessDay,
  nextCycleDate,
  resolveScheduledDate,
  truncateToMonthEnd,
} from './calendar';
import type { CalendarCadence, CalendarConfig } from './calendar.types';

const WEEKENDS: CalendarConfig = { nonBusinessWeekdays: [0, 6] };
const NO_WEEKENDS: CalendarConfig = { nonBusinessWeekdays: [] };

const holidays = (...dates: string[]): ReadonlySet<string> => new Set(dates);

describe('daysInMonth', () => {
  it('knows the length of every month', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('rejects an invalid month', () => {
    expect(() => daysInMonth(2026, 13)).toThrow(/Invalid calendar month/);
  });
});

describe('truncateToMonthEnd', () => {
  it('keeps a day that exists in the destination month', () => {
    expect(truncateToMonthEnd(2026, 1, 31)).toBe('2026-01-31');
    expect(truncateToMonthEnd(2026, 3, 15)).toBe('2026-03-15');
  });

  it('truncates day 31 to the last day of a shorter month', () => {
    expect(truncateToMonthEnd(2026, 2, 31)).toBe('2026-02-28');
    expect(truncateToMonthEnd(2026, 4, 31)).toBe('2026-04-30');
    expect(truncateToMonthEnd(2026, 5, 31)).toBe('2026-05-31');
    expect(truncateToMonthEnd(2026, 6, 31)).toBe('2026-06-30');
  });

  it('truncates Feb 29 to Feb 28 on a non-leap year', () => {
    expect(truncateToMonthEnd(2027, 2, 29)).toBe('2027-02-28');
  });

  it('keeps Feb 29 on a leap year', () => {
    expect(truncateToMonthEnd(2028, 2, 29)).toBe('2028-02-29');
  });

  it('rejects an invalid day', () => {
    expect(() => truncateToMonthEnd(2026, 1, 32)).toThrow(
      /Invalid calendar day/,
    );
  });
});

describe('isBusinessDay', () => {
  it('treats configured weekends as non-business days', () => {
    expect(isBusinessDay('2026-01-03', WEEKENDS)).toBe(false);
    expect(isBusinessDay('2026-01-04', WEEKENDS)).toBe(false);
    expect(isBusinessDay('2026-01-05', WEEKENDS)).toBe(true);
  });

  it('honours a custom weekend configuration', () => {
    const custom: CalendarConfig = { nonBusinessWeekdays: [5, 6] };
    expect(isBusinessDay('2026-01-02', custom)).toBe(false);
    expect(isBusinessDay('2026-01-04', custom)).toBe(true);
  });

  it('treats configured holidays as non-business days', () => {
    expect(isBusinessDay('2026-12-25', WEEKENDS, holidays('2026-12-25'))).toBe(
      false,
    );
    expect(isBusinessDay('2026-12-24', WEEKENDS, holidays('2026-12-25'))).toBe(
      true,
    );
  });

  it('rejects an invalid date', () => {
    expect(() => isBusinessDay('not-a-date', WEEKENDS)).toThrow(
      /Invalid calendar date/,
    );
  });
});

describe('nextBusinessDay', () => {
  it('returns the same date when it is already a business day', () => {
    expect(nextBusinessDay('2026-01-05', WEEKENDS)).toBe('2026-01-05');
  });

  it('moves a weekend date to the next business day', () => {
    expect(nextBusinessDay('2026-01-03', WEEKENDS)).toBe('2026-01-05');
  });

  it('crosses the month boundary', () => {
    expect(nextBusinessDay('2026-01-31', WEEKENDS)).toBe('2026-02-02');
  });

  it('crosses the year boundary over consecutive holidays', () => {
    const newYear: CalendarConfig = { nonBusinessWeekdays: [0, 6] };
    expect(
      nextBusinessDay(
        '2027-01-01',
        newYear,
        holidays('2027-01-01', '2027-01-04'),
      ),
    ).toBe('2027-01-05');
  });

  it('skips a long holiday streak', () => {
    expect(
      nextBusinessDay(
        '2026-04-01',
        NO_WEEKENDS,
        holidays('2026-04-01', '2026-04-02', '2026-04-03'),
      ),
    ).toBe('2026-04-04');
  });

  it('fails loudly when no business day can ever be reached', () => {
    const alwaysClosed: CalendarConfig = {
      nonBusinessWeekdays: [0, 1, 2, 3, 4, 5, 6],
    };
    expect(() => nextBusinessDay('2026-01-05', alwaysClosed)).toThrow(
      /Unable to find a business day/,
    );
  });
});

describe('resolveScheduledDate', () => {
  it('truncates to the destination month end before shifting to a business day', () => {
    expect(resolveScheduledDate(2026, 2, 31, WEEKENDS)).toBe('2026-03-02');
    expect(resolveScheduledDate(2026, 5, 31, WEEKENDS)).toBe('2026-06-01');
  });

  it('truncates Feb 29 on a non-leap year and then shifts', () => {
    expect(resolveScheduledDate(2027, 2, 29, WEEKENDS)).toBe('2027-03-01');
  });

  it('keeps Feb 29 on a leap year', () => {
    expect(resolveScheduledDate(2028, 2, 29, WEEKENDS)).toBe('2028-02-29');
  });

  it('does not move an anchor that already lands on a business day', () => {
    expect(resolveScheduledDate(2026, 3, 16, WEEKENDS)).toBe('2026-03-16');
  });
});

describe('nextCycleDate', () => {
  const cases: Array<{
    cadence: CalendarCadence;
    anchor: string;
    today: string;
    expected: string;
  }> = [
    {
      cadence: 'monthly',
      anchor: '2026-06-01',
      today: '2026-05-10',
      expected: '2026-06-01',
    },
    {
      cadence: 'daily',
      anchor: '2026-06-01',
      today: '2026-05-10',
      expected: '2026-06-01',
    },
    {
      cadence: 'monthly',
      anchor: '2026-05-10',
      today: '2026-05-10',
      expected: '2026-05-10',
    },
    {
      cadence: 'daily',
      anchor: '2026-01-01',
      today: '2026-01-10',
      expected: '2026-01-10',
    },
    {
      cadence: 'weekly',
      anchor: '2026-01-01',
      today: '2026-01-08',
      expected: '2026-01-08',
    },
    {
      cadence: 'weekly',
      anchor: '2026-01-01',
      today: '2026-01-09',
      expected: '2026-01-15',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-10',
      today: '2026-02-10',
      expected: '2026-02-10',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-10',
      today: '2026-02-11',
      expected: '2026-03-10',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      today: '2026-02-01',
      expected: '2026-02-28',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      today: '2026-03-01',
      expected: '2026-03-31',
    },
    {
      cadence: 'monthly',
      anchor: '2026-03-31',
      today: '2026-04-01',
      expected: '2026-04-30',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2026-01-01',
      expected: '2026-02-28',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2028-01-01',
      expected: '2028-02-29',
    },
  ];

  it.each(cases)(
    'computes the next nominal cycle date for $cadence from $anchor on $today -> $expected',
    ({ cadence, anchor, today, expected }) => {
      expect(nextCycleDate(anchor, cadence, today)).toBe(expected);
    },
  );
});

describe('currentCycleDate', () => {
  const cases: Array<{
    cadence: CalendarCadence;
    anchor: string;
    today: string;
    expected: string | null;
  }> = [
    {
      cadence: 'monthly',
      anchor: '2026-06-01',
      today: '2026-05-10',
      expected: null,
    },
    {
      cadence: 'monthly',
      anchor: '2026-05-10',
      today: '2026-05-10',
      expected: '2026-05-10',
    },
    {
      cadence: 'daily',
      anchor: '2026-01-01',
      today: '2026-01-10',
      expected: '2026-01-10',
    },
    {
      cadence: 'weekly',
      anchor: '2026-01-01',
      today: '2026-01-08',
      expected: '2026-01-08',
    },
    {
      cadence: 'weekly',
      anchor: '2026-01-01',
      today: '2026-01-09',
      expected: '2026-01-08',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-10',
      today: '2026-02-10',
      expected: '2026-02-10',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-10',
      today: '2026-02-11',
      expected: '2026-02-10',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      today: '2026-02-01',
      expected: '2026-01-31',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      today: '2026-03-02',
      expected: '2026-02-28',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      today: '2026-03-31',
      expected: '2026-03-31',
    },
    {
      cadence: 'monthly',
      anchor: '2026-03-31',
      today: '2026-04-30',
      expected: '2026-04-30',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2026-01-01',
      expected: '2025-02-28',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2026-03-02',
      expected: '2026-02-28',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2028-01-01',
      expected: '2027-02-28',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      today: '2028-02-29',
      expected: '2028-02-29',
    },
  ];

  it.each(cases)(
    'computes the current nominal cycle date for $cadence from $anchor on $today -> $expected',
    ({ cadence, anchor, today, expected }) => {
      expect(currentCycleDate(anchor, cadence, today)).toBe(expected);
    },
  );
});

describe('cycleDateAt', () => {
  const cases: Array<{
    cadence: CalendarCadence;
    anchor: string;
    index: number;
    expected: string;
  }> = [
    {
      cadence: 'daily',
      anchor: '2026-01-01',
      index: 0,
      expected: '2026-01-01',
    },
    {
      cadence: 'daily',
      anchor: '2026-01-01',
      index: 9,
      expected: '2026-01-10',
    },
    {
      cadence: 'weekly',
      anchor: '2026-01-01',
      index: 1,
      expected: '2026-01-08',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      index: 1,
      expected: '2026-02-28',
    },
    {
      cadence: 'monthly',
      anchor: '2026-01-31',
      index: 3,
      expected: '2026-04-30',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      index: 1,
      expected: '2025-02-28',
    },
    {
      cadence: 'annual',
      anchor: '2024-02-29',
      index: 4,
      expected: '2028-02-29',
    },
  ];

  it.each(cases)(
    'computes the nominal cycle $index for $cadence from $anchor -> $expected',
    ({ cadence, anchor, index, expected }) => {
      expect(cycleDateAt(anchor, cadence, index)).toBe(expected);
    },
  );

  it('rejects a negative cycle index', () => {
    expect(() => cycleDateAt('2026-01-01', 'monthly', -1)).toThrow(
      /Invalid cycle index/,
    );
  });
});

describe('isOverdueByTolerance', () => {
  it('never treats a future or same-day schedule as overdue', () => {
    expect(isOverdueByTolerance('2026-02-10', '2026-02-10', 15)).toBe(false);
    expect(isOverdueByTolerance('2026-02-11', '2026-02-10', 15)).toBe(false);
  });

  it('treats a passed schedule date as overdue beyond the default 15 minutes', () => {
    expect(isOverdueByTolerance('2026-02-10', '2026-02-11', 15)).toBe(true);
    expect(isOverdueByTolerance('2026-02-10', '2026-03-02', 15)).toBe(true);
  });

  it('stays within a tolerance configured larger than a day', () => {
    expect(isOverdueByTolerance('2026-02-10', '2026-02-11', 1_500)).toBe(false);
    expect(isOverdueByTolerance('2026-02-10', '2026-02-13', 1_500)).toBe(true);
  });
});
