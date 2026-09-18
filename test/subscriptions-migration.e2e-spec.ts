import { Client, Pool } from 'pg';
import { MigrationRunner } from '../src/database/migration-runner';
import { MIGRATIONS } from '../src/database/migrations';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';

interface SubscriptionRow {
  id: string;
  amount: string;
  currency: string;
  frequency: string;
  anchor_date: string;
  timezone: string;
  status: string;
  created_at: Date;
  cancelled_at: Date | null;
}

interface SubscriptionInput {
  amount: number;
  currency: string;
  frequency: string;
  anchor_date: string;
  timezone: string;
  status: string;
  cancelled_at: string | null;
}

describe('subscriptions migration (e2e)', () => {
  const schema = `t8_${process.pid}_${Date.now()}`;
  const baseInput: SubscriptionInput = {
    amount: 100,
    currency: 'USD',
    frequency: 'monthly',
    anchor_date: '2026-01-10',
    timezone: 'UTC',
    status: 'ACTIVE',
    cancelled_at: null,
  };

  let admin: Client;
  let pool: Pool;
  let runner: MigrationRunner;
  let applied: string[];

  const insertSubscription = (overrides: Partial<SubscriptionInput> = {}) => {
    const input: SubscriptionInput = { ...baseInput, ...overrides };
    return pool.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.amount,
        input.currency,
        input.frequency,
        input.anchor_date,
        input.timezone,
        input.status,
        input.cancelled_at,
      ],
    );
  };

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

  it('applies the subscriptions migration from scratch', async () => {
    expect(applied).toContain('001-create-subscriptions');

    const migrations = await pool.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    expect(migrations.rows.map((row) => row.id)).toContain(
      '001-create-subscriptions',
    );

    const table = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'subscriptions'
       ) AS present`,
      [schema],
    );
    expect(table.rows[0].present).toBe(true);
  });

  it('is reproducible and idempotent when run again', async () => {
    const second = await runner.run();
    expect(second).toEqual([]);

    const migrations = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM schema_migrations',
    );
    expect(migrations.rows[0].count).toBe(MIGRATIONS.length);
  });

  it('stores a subscription with ACTIVE default and no cancellation', async () => {
    const { rows } = await insertSubscription();

    expect(rows[0].status).toBe('ACTIVE');
    expect(Number(rows[0].amount)).toBe(100);
    expect(rows[0].currency).toBe('USD');
    expect(rows[0].frequency).toBe('monthly');
    expect(rows[0].cancelled_at).toBeNull();
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it('rejects an unknown status', async () => {
    await expect(insertSubscription({ status: 'DELETED' })).rejects.toThrow(
      /subscriptions_status_check/,
    );
  });

  it('rejects an unknown frequency', async () => {
    await expect(insertSubscription({ frequency: 'hourly' })).rejects.toThrow(
      /subscriptions_frequency_check/,
    );
  });

  it('rejects a non-positive amount', async () => {
    await expect(insertSubscription({ amount: 0 })).rejects.toThrow(
      /subscriptions_amount_check/,
    );
  });

  it('rejects a malformed currency', async () => {
    await expect(insertSubscription({ currency: 'usd' })).rejects.toThrow(
      /subscriptions_currency_check/,
    );
  });

  it('requires cancelled_at to be set exactly when the status is CANCELLED', async () => {
    await expect(
      insertSubscription({ status: 'CANCELLED', cancelled_at: null }),
    ).rejects.toThrow(/subscriptions_cancelled_at_consistent/);

    await expect(
      insertSubscription({
        status: 'ACTIVE',
        cancelled_at: '2026-02-01T00:00:00Z',
      }),
    ).rejects.toThrow(/subscriptions_cancelled_at_consistent/);

    const { rows } = await insertSubscription({
      status: 'CANCELLED',
      cancelled_at: '2026-02-01T00:00:00Z',
    });
    expect(rows[0].status).toBe('CANCELLED');
    expect(rows[0].cancelled_at).toBeInstanceOf(Date);
  });

  it('keeps amount and currency immutable for the life of the subscription', async () => {
    const { rows } = await insertSubscription();

    await expect(
      pool.query('UPDATE subscriptions SET amount = 200 WHERE id = $1', [
        rows[0].id,
      ]),
    ).rejects.toThrow(/immutable/);

    await expect(
      pool.query('UPDATE subscriptions SET currency = $1 WHERE id = $2', [
        'EUR',
        rows[0].id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('allows ACTIVE -> PAUSED -> ACTIVE and PAUSED -> CANCELLED', async () => {
    const { rows } = await insertSubscription();
    const id = rows[0].id;

    const paused = await pool.query<SubscriptionRow>(
      `UPDATE subscriptions SET status = 'PAUSED' WHERE id = $1 RETURNING *`,
      [id],
    );
    expect(paused.rows[0].status).toBe('PAUSED');

    const resumed = await pool.query<SubscriptionRow>(
      `UPDATE subscriptions SET status = 'ACTIVE' WHERE id = $1 RETURNING *`,
      [id],
    );
    expect(resumed.rows[0].status).toBe('ACTIVE');

    const cancelled = await pool.query<SubscriptionRow>(
      `UPDATE subscriptions SET status = 'CANCELLED', cancelled_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    expect(cancelled.rows[0].status).toBe('CANCELLED');
    expect(cancelled.rows[0].cancelled_at).toBeInstanceOf(Date);
  });

  it('forbids any transition out of CANCELLED', async () => {
    const { rows } = await insertSubscription({
      status: 'CANCELLED',
      cancelled_at: '2026-02-01T00:00:00Z',
    });

    await expect(
      pool.query(`UPDATE subscriptions SET status = 'ACTIVE' WHERE id = $1`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/CANCELLED subscription cannot transition/);
  });
});
