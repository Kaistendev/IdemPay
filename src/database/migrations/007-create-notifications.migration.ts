import type { Migration } from '../migration.types';

export const createNotificationsMigration: Migration = {
  id: '007-create-notifications',
  sql: `
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('CancellationEvent')),
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_type_idx ON notifications (type);
CREATE INDEX notifications_aggregate_idx ON notifications (aggregate_id);
CREATE INDEX notifications_created_at_idx ON notifications (created_at);

CREATE FUNCTION notifications_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbox notifications are append-only' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER notifications_guard_update
BEFORE UPDATE ON notifications
FOR EACH ROW EXECUTE FUNCTION notifications_guard_update();
`,
};
