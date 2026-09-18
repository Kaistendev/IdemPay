import type { Migration } from '../migration.types';
import { createSubscriptionsMigration } from './001-create-subscriptions.migration';
import { createBillingIntentsMigration } from './002-create-billing-intents.migration';
import { createCalendarNonBusinessDaysMigration } from './003-create-calendar-non-business-days.migration';

export const MIGRATIONS: readonly Migration[] = [
  createSubscriptionsMigration,
  createBillingIntentsMigration,
  createCalendarNonBusinessDaysMigration,
];
