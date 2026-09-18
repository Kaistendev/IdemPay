export const SCHEDULING_TIMEZONE = 'SCHEDULING_TIMEZONE';

export const DEFAULT_SCHEDULING_TIMEZONE = 'UTC';

function canFormatWith(timeZone: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone });
    return formatter.format(0).length > 0;
  } catch {
    return false;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  return canFormatWith(timeZone);
}

export function assertValidTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
}

export function readSchedulingTimeZone(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.SCHEDULING_TIMEZONE?.trim();
  const timeZone =
    configured && configured.length > 0
      ? configured
      : DEFAULT_SCHEDULING_TIMEZONE;
  assertValidTimeZone(timeZone);
  return timeZone;
}
