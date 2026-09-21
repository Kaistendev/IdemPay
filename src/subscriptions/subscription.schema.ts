import { z } from 'zod';
import { isValidTimeZone } from '../common/time/scheduling-timezone';
import { ISO_4217_CURRENCY_CODES } from './iso4217';

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

export const createSubscriptionSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.enum(ISO_4217_CURRENCY_CODES),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'annual']),
  startDate: z.string().refine(isCalendarDate, {
    message: 'startDate must be a valid calendar date (YYYY-MM-DD)',
  }),
  timezone: z
    .string()
    .min(1)
    .refine(isValidTimeZone, { message: 'timezone must be a valid IANA zone' }),
});

export type CreateSubscriptionRequest = z.infer<
  typeof createSubscriptionSchema
>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const subscriptionParamsSchema = z.object({
  id: z.string().regex(UUID_PATTERN, { message: 'id must be a valid UUID' }),
});

export type SubscriptionParams = z.infer<typeof subscriptionParamsSchema>;
