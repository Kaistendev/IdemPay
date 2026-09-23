import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ChargeExecutorService } from '../src/charge-executor/charge-executor.service';
import { PAYMENT_SCENARIO } from '../src/gateway/payment-scenario';
import { PG_POOL } from '../src/health/health.constants';

const scenarioOf = (scenario: string) =>
  Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_SCENARIO)
    .useValue(scenario);

const makeIntentDue = (pool: Pool, intentId: string) =>
  pool.query(
    `UPDATE billing_intents SET next_attempt_at = now() - interval '1 second'
     WHERE id = $1`,
    [intentId],
  );

const FAILED_FINAL_PAYLOAD: Record<string, unknown> = {
  subscriptionId: expect.any(String),
  billingIntentId: expect.any(String),
  reason: 'FAILED_FINAL',
};

describe('exhaustion cancels the subscription and emits the event (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorService;
  const createdSubscriptions: string[] = [];

  const createSubscription = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const createIntent = async (subscriptionId: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10'::date, 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const readSubscription = async (subscriptionId: string) => {
    const { rows } = await pool.query<{
      status: string;
      cancelledAt: Date | null;
    }>(
      `SELECT status, cancelled_at AS "cancelledAt"
       FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    return rows[0];
  };

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{
      status: string;
      settledAt: Date | null;
    }>(
      `SELECT status, settled_at AS "settledAt"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{
      attemptNo: number;
      status: string;
      errorType: string | null;
    }>(
      `SELECT auto_seq AS "attemptNo", status, error_type AS "errorType"
       FROM payment_attempts WHERE billing_intent_id = $1
       ORDER BY auto_seq`,
      [intentId],
    );
    return rows;
  };

  const readEvents = async (subscriptionId: string) => {
    const { rows } = await pool.query<{
      type: string;
      aggregateId: string;
      payload: {
        subscriptionId: string;
        billingIntentId: string;
        reason: string;
      };
    }>(
      `SELECT type, aggregate_id AS "aggregateId", payload
       FROM notifications WHERE aggregate_id = $1`,
      [subscriptionId],
    );
    return rows;
  };

  const cleanup = async () => {
    if (createdSubscriptions.length > 0) {
      await pool.query(
        `DELETE FROM notifications WHERE aggregate_id = ANY($1::uuid[])`,
        [createdSubscriptions],
      );
      await pool.query(
        `DELETE FROM payment_attempts
         WHERE billing_intent_id IN (
           SELECT id FROM billing_intents WHERE subscription_id = ANY($1::uuid[])
         )`,
        [createdSubscriptions],
      );
      await pool.query(
        'DELETE FROM billing_intents WHERE subscription_id = ANY($1::uuid[])',
        [createdSubscriptions],
      );
      await pool.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [
        createdSubscriptions,
      ]);
      createdSubscriptions.length = 0;
    }
  };

  beforeAll(async () => {
    moduleRef = await scenarioOf('PROVIDER_ERROR').compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    executor = moduleRef.get(ChargeExecutorService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('cancels the subscription and persists one CancellationEvent after exhausting five attempts // T58: @E2E-08 @RF-22', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await executor.execute(intentId);
      expect(result).toMatchObject({
        outcome: attempt < 5 ? 'RETRY_PENDING' : 'FAILED_FINAL',
        billingIntentId: intentId,
        attemptNo: attempt,
        errorType: 'PROVIDER_ERROR',
      });
      await makeIntentDue(pool, intentId);
    }

    const intent = await readIntent(intentId);
    expect(intent).toMatchObject({ status: 'FAILED_FINAL' });
    expect(intent.settledAt).toBeInstanceOf(Date);
    expect(await readAttempts(intentId)).toHaveLength(5);

    const subscription = await readSubscription(subscriptionId);
    expect(subscription).toMatchObject({ status: 'CANCELLED' });
    expect(subscription.cancelledAt).toBeInstanceOf(Date);

    const events = await readEvents(subscriptionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'CancellationEvent',
      aggregateId: subscriptionId,
    });
    expect(events[0].payload).toMatchObject(FAILED_FINAL_PAYLOAD);
    expect(events[0].payload).toMatchObject({
      subscriptionId,
      billingIntentId: intentId,
    });

    const replayed = await executor.execute(intentId);
    expect(replayed).toMatchObject({ outcome: 'NOT_STARTED' });
    expect(await readAttempts(intentId)).toHaveLength(5);
    expect(await readEvents(subscriptionId)).toHaveLength(1);
  });
});

describe('exhaustion on a non-retryable failure (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorService;
  const createdSubscriptions: string[] = [];

  const createSubscription = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const createIntent = async (subscriptionId: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10'::date, 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const readSubscription = async (subscriptionId: string) => {
    const { rows } = await pool.query<{
      status: string;
      cancelledAt: Date | null;
    }>(
      `SELECT status, cancelled_at AS "cancelledAt"
       FROM subscriptions WHERE id = $1`,
      [subscriptionId],
    );
    return rows[0];
  };

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM billing_intents WHERE id = $1',
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM payment_attempts
       WHERE billing_intent_id = $1`,
      [intentId],
    );
    return rows;
  };

  const countEvents = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE aggregate_id = $1',
      [subscriptionId],
    );
    return rows[0].count;
  };

  const cleanup = async () => {
    if (createdSubscriptions.length > 0) {
      await pool.query(
        `DELETE FROM notifications WHERE aggregate_id = ANY($1::uuid[])`,
        [createdSubscriptions],
      );
      await pool.query(
        `DELETE FROM payment_attempts
         WHERE billing_intent_id IN (
           SELECT id FROM billing_intents WHERE subscription_id = ANY($1::uuid[])
         )`,
        [createdSubscriptions],
      );
      await pool.query(
        'DELETE FROM billing_intents WHERE subscription_id = ANY($1::uuid[])',
        [createdSubscriptions],
      );
      await pool.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [
        createdSubscriptions,
      ]);
      createdSubscriptions.length = 0;
    }
  };

  beforeAll(async () => {
    moduleRef = await scenarioOf('DECLINED').compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    executor = moduleRef.get(ChargeExecutorService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('cancels the subscription and emits the event on the first non-retryable failure // T58: @E2E-09 @RF-22', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const result = await executor.execute(intentId);
    expect(result).toMatchObject({
      outcome: 'FAILED_FINAL',
      billingIntentId: intentId,
      errorType: 'DECLINED',
    });

    expect((await readSubscription(subscriptionId)).status).toBe('CANCELLED');
    expect((await readIntent(intentId)).status).toBe('FAILED_FINAL');
    const attempts = await readAttempts(intentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'FAILED' });
    expect(await countEvents(subscriptionId)).toBe(1);
  });

  it('rolls back the cancellation when the event insert fails mid-transaction', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const functionName = `fail_cancellation_${process.pid}`;
    const triggerName = `fail_cancellation_trg_${process.pid}`;

    await pool.query(
      `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'simulated mid-transaction failure';
       END;
       $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON notifications
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );

    try {
      await expect(executor.execute(intentId)).rejects.toThrow(
        /simulated mid-transaction failure/,
      );

      const subscription = await readSubscription(subscriptionId);
      expect(subscription).toMatchObject({ status: 'ACTIVE' });
      expect(subscription.cancelledAt).toBeNull();
      expect(await countEvents(subscriptionId)).toBe(0);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('IN_FLIGHT');
      const attempts = await readAttempts(intentId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: 'IN_FLIGHT' });
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON notifications`,
      );
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });
});
