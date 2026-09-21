import { Client, Pool } from 'pg';
import { MigrationRunner } from '../src/database/migration-runner';
import { MIGRATIONS } from '../src/database/migrations';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';

const SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000001';

interface NotificationInput {
  type: string;
  aggregate_id: string;
  payload: unknown;
}

const insertNotification = (pool: Pool, input: NotificationInput) =>
  pool.query<{ id: string }>(
    `INSERT INTO notifications (type, aggregate_id, payload)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.type, input.aggregate_id, input.payload],
  );

const cancellationEvent = (): NotificationInput => ({
  type: 'CancellationEvent',
  aggregate_id: SUBSCRIPTION_ID,
  payload: {
    subscriptionId: SUBSCRIPTION_ID,
    reason: 'FAILED_FINAL',
  },
});

describe('notifications outbox migration (e2e)', () => {
  const schema = `t34_${process.pid}_${Date.now()}`;
  let admin: Client;
  let pool: Pool;
  let runner: MigrationRunner;
  let applied: string[];

  beforeAll(async () => {
    admin = new Client({ connectionString: CONNECTION_STRING });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      options: `-c search_path=${schema}`,
    });
    runner = new MigrationRunner(pool);
    applied = await runner.run();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('applies every migration from scratch', () => {
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(applied).toContain('007-create-notifications');
  });

  it('is reproducible and idempotent when run again', async () => {
    const second = await runner.run();
    expect(second).toEqual([]);

    const migrations = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM schema_migrations',
    );
    expect(migrations.rows[0].count).toBe(MIGRATIONS.length);
  });

  it('inserts a CancellationEvent with a JSON payload', async () => {
    const { rows } = await insertNotification(pool, cancellationEvent());
    expect(rows[0].id).toBeTruthy();
  });

  it('returns the inserted event when filtering by type and aggregate_id', async () => {
    const event: NotificationInput = {
      type: 'CancellationEvent',
      aggregate_id: '00000000-0000-0000-0000-000000000002',
      payload: {
        subscriptionId: '00000000-0000-0000-0000-000000000002',
        reason: 'ADMIN',
      },
    };
    const { rows } = await insertNotification(pool, event);

    const found = await pool.query<{
      type: string;
      aggregateId: string;
      payload: unknown;
    }>(
      `SELECT type, aggregate_id AS "aggregateId", payload
       FROM notifications
       WHERE type = $1 AND aggregate_id = $2`,
      [event.type, event.aggregate_id],
    );

    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({
      type: 'CancellationEvent',
      aggregateId: '00000000-0000-0000-0000-000000000002',
    });
    expect(found.rows[0].payload).toEqual(event.payload);
    expect(rows[0].id).toBeTruthy();
  });

  it('defaults created_at to now', async () => {
    await insertNotification(pool, cancellationEvent());

    const result = await pool.query<{ created_at: Date }>(
      'SELECT created_at FROM notifications',
    );
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
  });

  it('rejects an unknown event type', async () => {
    await expect(
      insertNotification(pool, { ...cancellationEvent(), type: 'RefundEvent' }),
    ).rejects.toThrow(/notifications_type_check/);
  });

  it('rejects an event without an aggregate', async () => {
    await expect(
      pool.query(
        `INSERT INTO notifications (type, aggregate_id, payload)
         VALUES ('CancellationEvent', NULL, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/aggregate_id/);
  });

  it('rejects an event without a payload', async () => {
    await expect(
      pool.query(
        `INSERT INTO notifications (type, aggregate_id, payload)
         VALUES ('CancellationEvent', $1, NULL)`,
        [SUBSCRIPTION_ID],
      ),
    ).rejects.toThrow(/payload/);
  });

  it('treats outbox rows as immutable (append-only)', async () => {
    const { rows } = await insertNotification(pool, cancellationEvent());

    await expect(
      pool.query(
        `UPDATE notifications
         SET payload = '{"changed":true}'::jsonb
         WHERE id = $1`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/append-only/);
  });
});
