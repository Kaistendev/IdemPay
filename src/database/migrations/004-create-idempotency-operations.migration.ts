import type { Migration } from '../migration.types';

export const createIdempotencyOperationsMigration: Migration = {
  id: '004-create-idempotency-operations',
  sql: `
CREATE TABLE idempotency_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  generation integer NOT NULL CHECK (generation >= 1),
  operation_type text NOT NULL CHECK (operation_type IN (
    'SUBSCRIPTION_CREATE',
    'SUBSCRIPTION_PAUSE',
    'SUBSCRIPTION_RESUME',
    'SUBSCRIPTION_CANCEL',
    'BILLING_CYCLE_CHARGE',
    'BILLING_INTENT_REPROCESS'
  )),
  payload_hash text NOT NULL CHECK (length(payload_hash) > 0),
  status text NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'SETTLED')),
  response_status integer,
  response_body jsonb,
  billing_intent_id uuid REFERENCES billing_intents (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  settled_at timestamptz,
  CONSTRAINT idempotency_operations_key_generation_unique UNIQUE (key, generation),
  CONSTRAINT idempotency_operations_settled_consistent
    CHECK (
      (status = 'SETTLED' AND response_status IS NOT NULL AND response_body IS NOT NULL)
      OR status <> 'SETTLED'
    ),
  CONSTRAINT idempotency_operations_processing_no_response
    CHECK (
      (status = 'PROCESSING' AND response_status IS NULL AND response_body IS NULL)
      OR status <> 'PROCESSING'
    ),
  CONSTRAINT idempotency_operations_expires_after_created
    CHECK (expires_at > created_at),
  CONSTRAINT idempotency_operations_lease_consistent
    CHECK ((status = 'PROCESSING') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT idempotency_operations_settled_at_consistent
    CHECK ((status = 'SETTLED') = (settled_at IS NOT NULL))
);

CREATE FUNCTION idempotency_operations_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.key <> OLD.key
     OR NEW.generation <> OLD.generation
     OR NEW.operation_type <> OLD.operation_type
     OR NEW.payload_hash <> OLD.payload_hash THEN
    RAISE EXCEPTION 'idempotency operation identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'SETTLED' AND NEW.status <> 'SETTLED' THEN
    RAISE EXCEPTION 'a SETTLED idempotency operation cannot transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER idempotency_operations_guard_update
BEFORE UPDATE ON idempotency_operations
FOR EACH ROW EXECUTE FUNCTION idempotency_operations_guard_update();
`,
};
