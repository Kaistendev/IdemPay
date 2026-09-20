import type { Migration } from '../migration.types';

export const addBillingIntentStatesMigration: Migration = {
  id: '005-add-billing-intent-states',
  sql: `
ALTER TABLE billing_intents
  ADD COLUMN omitted_reason text,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN unknown_since timestamptz,
  ADD COLUMN verify_count integer NOT NULL DEFAULT 0 CHECK (verify_count >= 0),
  ADD COLUMN next_verify_at timestamptz,
  ADD COLUMN needs_manual_review boolean NOT NULL DEFAULT false;

ALTER TABLE billing_intents
  DROP CONSTRAINT billing_intents_status_check,
  ADD CONSTRAINT billing_intents_status_check
    CHECK (status IN ('SCHEDULED', 'IN_FLIGHT', 'RETRY_PENDING', 'SUCCEEDED', 'FAILED_FINAL', 'UNKNOWN', 'OMITTED')),
  ADD CONSTRAINT billing_intents_omitted_reason_required
    CHECK ((status = 'OMITTED') = (omitted_reason IS NOT NULL)),
  ADD CONSTRAINT billing_intents_omitted_reason_valid
    CHECK (omitted_reason IS NULL
           OR omitted_reason IN ('ENGINE_DOWN', 'SUBSCRIPTION_PAUSED', 'SUBSCRIPTION_CANCELLED', 'OVERLAP')),
  ADD CONSTRAINT billing_intents_retry_pending_has_deadline
    CHECK (status <> 'RETRY_PENDING' OR next_attempt_at IS NOT NULL);

DROP INDEX billing_intents_live_unique;

CREATE UNIQUE INDEX billing_intents_live_unique
  ON billing_intents (subscription_id)
  WHERE status IN ('SCHEDULED', 'IN_FLIGHT', 'RETRY_PENDING', 'UNKNOWN');
`,
};
