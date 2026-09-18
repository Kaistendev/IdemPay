import type { CalendarConfig, Weekday } from './calendar.types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const MAX_LOOKAHEAD_DAYS = 3660;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid calendar month: ${month}`);
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseCalendarDate(value: string): CalendarDate {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new Error(`Invalid calendar date: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new Error(`Invalid calendar month: ${value}`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`Invalid calendar day: ${value}`);
  }
  return { year, month, day };
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

export function addCalendarDays(value: string, days: number): string {
  const date = parseCalendarDate(value);
  const shifted =
    Date.UTC(date.year, date.month - 1, date.day) + days * MILLISECONDS_PER_DAY;
  return new Date(shifted).toISOString().slice(0, 10);
}

export function weekdayOf(value: string): Weekday {
  const { year, month, day } = parseCalendarDate(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

export function truncateToMonthEnd(
  year: number,
  month: number,
  day: number,
): string {
  const limit = daysInMonth(year, month);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`Invalid calendar day: ${day}`);
  }
  return formatCalendarDate({ year, month, day: Math.min(day, limit) });
}

export function isBusinessDay(
  value: string,
  config: CalendarConfig,
  holidays: ReadonlySet<string> = new Set(),
): boolean {
  const weekday = weekdayOf(value);
  return !config.nonBusinessWeekdays.includes(weekday) && !holidays.has(value);
}

export function nextBusinessDay(
  value: string,
  config: CalendarConfig,
  holidays: ReadonlySet<string> = new Set(),
): string {
  let candidate = value;

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    if (isBusinessDay(candidate, config, holidays)) {
      return candidate;
    }
    candidate = addCalendarDays(candidate, 1);
  }

  throw new Error(
    `Unable to find a business day within ${MAX_LOOKAHEAD_DAYS} days from ${value}`,
  );
}

export function resolveScheduledDate(
  year: number,
  month: number,
  anchorDay: number,
  config: CalendarConfig,
  holidays: ReadonlySet<string> = new Set(),
): string {
  return nextBusinessDay(
    truncateToMonthEnd(year, month, anchorDay),
    config,
    holidays,
  );
}
