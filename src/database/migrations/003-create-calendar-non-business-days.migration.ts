import type { Migration } from '../migration.types';

export const createCalendarNonBusinessDaysMigration: Migration = {
  id: '003-create-calendar-non-business-days',
  sql: `
CREATE TABLE calendar_non_business_days (
  date date PRIMARY KEY,
  reason text NOT NULL CHECK (length(reason) > 0)
);
`,
};
