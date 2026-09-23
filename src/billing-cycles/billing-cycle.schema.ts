import { z } from 'zod';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const billingCycleChargeParamsSchema = z.object({
  id: z.string().regex(UUID_PATTERN, { message: 'id must be a valid UUID' }),
  cycle: z.string().refine(isCalendarDate, {
    message: 'cycle must be a valid calendar date (YYYY-MM-DD)',
  }),
});
