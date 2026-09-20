import type { Migration } from '../migration.types';

export const addPaymentAttemptTriggersMigration: Migration = {
  id: '006-add-payment-attempt-triggers',
  sql: `
ALTER TABLE payment_attempts
  ADD COLUMN trigger text NOT NULL DEFAULT 'AUTO',
  ADD COLUMN auto_seq integer,
  ADD COLUMN deadline_at timestamptz;

UPDATE payment_attempts SET auto_seq = attempt_no WHERE trigger = 'AUTO';

ALTER TABLE payment_attempts
  DROP CONSTRAINT payment_attempts_attempt_unique,
  ADD CONSTRAINT payment_attempts_trigger_check
    CHECK (trigger IN ('AUTO', 'MANUAL')),
  ADD CONSTRAINT payment_attempts_auto_seq_check
    CHECK ((trigger = 'AUTO' AND auto_seq BETWEEN 1 AND 5 AND auto_seq IS NOT NULL)
        OR (trigger = 'MANUAL' AND auto_seq IS NULL)),
  ADD CONSTRAINT payment_attempts_auto_seq_unique
    UNIQUE (billing_intent_id, auto_seq);

ALTER TABLE payment_attempts
  DROP COLUMN attempt_no;

DROP FUNCTION payment_attempts_guard_update CASCADE;

CREATE FUNCTION payment_attempts_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_intent_id <> OLD.billing_intent_id
     OR NEW.trigger <> OLD.trigger
     OR NEW.auto_seq IS DISTINCT FROM OLD.auto_seq
     OR NEW.provider_operation_id <> OLD.provider_operation_id THEN
    RAISE EXCEPTION 'payment attempt identity and provider operation are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SUCCEEDED' AND NEW.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'a SUCCEEDED payment attempt cannot transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_attempts_guard_update
BEFORE UPDATE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION payment_attempts_guard_update();
`,
};
