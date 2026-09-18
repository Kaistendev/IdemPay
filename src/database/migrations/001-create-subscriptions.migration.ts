import type { Migration } from '../migration.types';

export const createSubscriptionsMigration: Migration = {
  id: '001-create-subscriptions',
  sql: `
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount numeric(20, 6) NOT NULL CHECK (amount > 0),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'annual')),
  anchor_date date NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT subscriptions_cancelled_at_consistent
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

CREATE INDEX subscriptions_status_idx ON subscriptions (status);

CREATE FUNCTION subscriptions_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'amount and currency are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'a CANCELLED subscription cannot transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_guard_update
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION subscriptions_guard_update();
`,
};
