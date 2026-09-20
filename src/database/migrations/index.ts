import type { Migration } from '../migration.types';
import { createSubscriptionsMigration } from './001-create-subscriptions.migration';
import { createBillingIntentsMigration } from './002-create-billing-intents.migration';
import { createCalendarNonBusinessDaysMigration } from './003-create-calendar-non-business-days.migration';
import { createIdempotencyOperationsMigration } from './004-create-idempotency-operations.migration';
import { addBillingIntentStatesMigration } from './005-add-billing-intent-states.migration';
import { addPaymentAttemptTriggersMigration } from './006-add-payment-attempt-triggers.migration';

export const MIGRATIONS: readonly Migration[] = [
  createSubscriptionsMigration,
  createBillingIntentsMigration,
  createCalendarNonBusinessDaysMigration,
  createIdempotencyOperationsMigration,
  addBillingIntentStatesMigration,
  addPaymentAttemptTriggersMigration,
];
