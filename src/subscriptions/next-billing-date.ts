import type { SubscriptionFrequency } from './subscriptions.types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: string): CalendarDate {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toUtcMilliseconds({ year, month, day }: CalendarDate): number {
  return Date.UTC(year, month - 1, day);
}

function formatUtc(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function addFixedCadence(
  anchorMilliseconds: number,
  stepDays: number,
  todayMilliseconds: number,
): string {
  const period = stepDays * MILLISECONDS_PER_DAY;
  const periods = Math.ceil((todayMilliseconds - anchorMilliseconds) / period);
  return formatUtc(anchorMilliseconds + periods * period);
}

function addMonthCadence(
  anchor: CalendarDate,
  stepMonths: number,
  todayMilliseconds: number,
): string {
  let year = anchor.year;
  let month = anchor.month;

  for (;;) {
    const candidate = Date.UTC(
      year,
      month - 1,
      Math.min(anchor.day, daysInMonth(year, month)),
    );
    if (candidate >= todayMilliseconds) {
      return formatUtc(candidate);
    }

    month += stepMonths;
    year += Math.floor((month - 1) / 12);
    month = ((month - 1) % 12) + 1;
  }
}

export function nextBillingDate(
  anchorDate: string,
  frequency: SubscriptionFrequency,
  today: string,
): string {
  const anchor = parseDate(anchorDate);
  const anchorMilliseconds = toUtcMilliseconds(anchor);
  const todayMilliseconds = toUtcMilliseconds(parseDate(today));

  if (todayMilliseconds <= anchorMilliseconds) {
    return anchorDate;
  }

  switch (frequency) {
    case 'daily':
      return addFixedCadence(anchorMilliseconds, 1, todayMilliseconds);
    case 'weekly':
      return addFixedCadence(anchorMilliseconds, 7, todayMilliseconds);
    case 'monthly':
      return addMonthCadence(anchor, 1, todayMilliseconds);
    case 'annual':
      return addMonthCadence(anchor, 12, todayMilliseconds);
  }
}
