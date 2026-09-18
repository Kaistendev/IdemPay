import type { CalendarConfig, Weekday } from './calendar.types';

export const DEFAULT_NON_BUSINESS_WEEKDAYS: readonly Weekday[] = [0, 6];

export function readCalendarConfig(
  env: NodeJS.ProcessEnv = process.env,
): CalendarConfig {
  const configured = env.CALENDAR_NON_BUSINESS_WEEKDAYS?.trim();
  if (configured === undefined || configured.length === 0) {
    return { nonBusinessWeekdays: DEFAULT_NON_BUSINESS_WEEKDAYS };
  }

  const weekdays = configured
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(Number);

  for (const weekday of weekdays) {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error(`Invalid CALENDAR_NON_BUSINESS_WEEKDAYS: ${configured}`);
    }
  }

  return { nonBusinessWeekdays: [...new Set(weekdays)] as Weekday[] };
}
