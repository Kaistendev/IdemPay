import type { Migration } from '../migration.types';

export const createBillingIntentsMigration: Migration = {
  id: '002-create-billing-intents',
  sql: `
CREATE TABLE billing_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  billing_cycle text NOT NULL CHECK (billing_cycle ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  schedule_date date NOT NULL,
  amount numeric(20, 6) NOT NULL CHECK (amount > 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_FINAL', 'UNKNOWN', 'OMITTED')),
  origin_idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT billing_intents_identity_unique UNIQUE (subscription_id, billing_cycle),
  CONSTRAINT billing_intents_settled_at_consistent
    CHECK ((status IN ('SUCCEEDED', 'FAILED_FINAL', 'OMITTED')) = (settled_at IS NOT NULL))
);

CREATE UNIQUE INDEX billing_intents_live_unique
  ON billing_intents (subscription_id)
  WHERE status IN ('SCHEDULED', 'IN_FLIGHT', 'UNKNOWN');

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_intent_id uuid NOT NULL REFERENCES billing_intents (id),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 5),
  provider_operation_id text NOT NULL CHECK (length(provider_operation_id) > 0),
  status text NOT NULL CHECK (status IN ('IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  error_type text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT payment_attempts_attempt_unique UNIQUE (billing_intent_id, attempt_no),
  CONSTRAINT payment_attempts_provider_operation_unique UNIQUE (provider_operation_id),
  CONSTRAINT payment_attempts_finished_at_consistent
    CHECK ((status = 'IN_FLIGHT') = (finished_at IS NULL))
);

CREATE UNIQUE INDEX payment_attempts_in_flight_unique
  ON payment_attempts (billing_intent_id)
  WHERE status = 'IN_FLIGHT';

CREATE UNIQUE INDEX payment_attempts_succeeded_unique
  ON payment_attempts (billing_intent_id)
  WHERE status = 'SUCCEEDED';

CREATE FUNCTION billing_intents_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subscription_id <> OLD.subscription_id
     OR NEW.billing_cycle <> OLD.billing_cycle
     OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'billing intent identity, amount and currency are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SUCCEEDED' AND NEW.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'a SUCCEEDED billing intent cannot transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_intents_guard_update
BEFORE UPDATE ON billing_intents
FOR EACH ROW EXECUTE FUNCTION billing_intents_guard_update();

CREATE FUNCTION payment_attempts_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_intent_id <> OLD.billing_intent_id
     OR NEW.attempt_no <> OLD.attempt_no
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
