import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PAYMENT_SCENARIO } from '../src/gateway/payment-scenario';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyLockKey } from '../src/idempotency/idempotency.constants';
import type { BillingCycleChargeResponse } from '../src/billing-cycles/billing-cycle.types';

// T45 — external billing cycle charge: @RF-04 @RF-11 @RF-12 @INV-02 @E2E-03
describe('billing cycle charge (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  const runId = `t45-${process.pid}-${Date.now()}`;
  const createdSubscriptions: string[] = [];
  const createdKeys: string[] = [];
  const createdOperationKeys: string[] = [];
  let keyCounter = 0;
  let cycleCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    const key = `${runId}-${keyCounter}`;
    createdKeys.push(idempotencyLockKey(key));
    createdOperationKeys.push(key);
    return key;
  };

  const nextCycle = (): string => {
    cycleCounter += 1;
    const date = new Date(Date.UTC(2026, 0, 2 + cycleCounter * 14));
    return date.toISOString().slice(0, 10);
  };

  const createSubscription = async (status = 'ACTIVE'): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status, cancelled_at)
       VALUES (100, 'USD', 'monthly', '2026-01-10', 'UTC', $1,
               CASE WHEN $1 = 'CANCELLED' THEN now() ELSE NULL END)
       RETURNING id`,
      [status],
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const charge = (subscriptionId: string, cycle: string, key: string) =>
    request(app.getHttpServer())
      .post(`/subscriptions/${subscriptionId}/billing-cycles/${cycle}/charge`)
      .set('Idempotency-Key', key);

  const intentCount = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM billing_intents WHERE subscription_id = $1`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const attemptCount = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM payment_attempts
       WHERE billing_intent_id IN (
         SELECT id FROM billing_intents WHERE subscription_id = $1
       )`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const latestOperation = async (key: string) => {
    const { rows } = await pool.query<{
      generation: number;
      status: string;
      operationType: string;
      responseStatus: number | null;
      billingIntentId: string | null;
    }>(
      `SELECT generation, status, operation_type AS "operationType",
              response_status AS "responseStatus",
              billing_intent_id AS "billingIntentId"
       FROM idempotency_operations WHERE key = $1
       ORDER BY generation DESC LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_SCENARIO)
      .useValue('SUCCESS')
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdOperationKeys.length > 0) {
      await pool.query(
        'DELETE FROM idempotency_operations WHERE key = ANY($1)',
        [createdOperationKeys],
      );
    }
    if (createdSubscriptions.length > 0) {
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
    }
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await app.close();
  });

  it('creates a single billing intent and settles it synchronously', async () => {
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();

    const response = await charge(subscriptionId, cycle, key);

    expect(response.status).toBe(200);
    const body = response.body as BillingCycleChargeResponse;
    expect(body).toMatchObject({
      subscriptionId,
      billingCycle: cycle,
      scheduleDate: cycle,
      amount: 100,
      currency: 'USD',
      status: 'SUCCEEDED',
      omittedReason: null,
      created: true,
    });
    expect(typeof body.settledAt).toBe('string');
    expect(body.id).toMatch(/^[0-9a-f-]+$/);

    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);

    const operation = await latestOperation(key);
    expect(operation).toMatchObject({
      generation: 1,
      status: 'SETTLED',
      operationType: 'BILLING_CYCLE_CHARGE',
      responseStatus: 200,
    });
    expect(operation?.billingIntentId).toBe(body.id);
  });

  it('generates a single intent for two distinct keys of the same cycle', async () => {
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();

    const first = await charge(subscriptionId, cycle, nextKey());
    const second = await charge(subscriptionId, cycle, nextKey());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = first.body as BillingCycleChargeResponse;
    const secondBody = second.body as BillingCycleChargeResponse;
    expect(firstBody.created).toBe(true);
    expect(secondBody).toMatchObject({
      id: firstBody.id,
      created: false,
      status: 'SUCCEEDED',
    });

    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);
  });

  it('expires an old key into a new operation without a second intent', async () => {
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();

    await charge(subscriptionId, cycle, key);

    await pool.query(
      `UPDATE idempotency_operations
       SET created_at = now() - interval '1 minute',
           expires_at = now() - interval '10 seconds'
       WHERE key = $1`,
      [key],
    );

    const retry = await charge(subscriptionId, cycle, key);

    expect(retry.status).toBe(200);
    const body = retry.body as BillingCycleChargeResponse;
    expect(body.created).toBe(false);

    const operation = await latestOperation(key);
    expect(operation).toMatchObject({
      generation: 2,
      status: 'SETTLED',
      responseStatus: 200,
    });
    expect(operation?.billingIntentId).toBe(body.id);

    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);
  });

  it('replays the settled response for a repeated idempotency key', async () => {
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();

    const first = await charge(subscriptionId, cycle, key);
    const second = await charge(subscriptionId, cycle, key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await charge(
      '00000000-0000-0000-0000-000000000000',
      nextCycle(),
      nextKey(),
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('rejects a new cycle for a non-ACTIVE subscription with 409', async () => {
    const subscriptionId = await createSubscription('PAUSED');

    const response = await charge(subscriptionId, nextCycle(), nextKey());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'INVALID_TRANSITION' });
    expect(await intentCount(subscriptionId)).toBe(0);
  });

  it('requires an Idempotency-Key', async () => {
    const subscriptionId = await createSubscription();

    const response = await request(app.getHttpServer()).post(
      `/subscriptions/${subscriptionId}/billing-cycles/${nextCycle()}/charge`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('rejects a malformed subscription id with 400', async () => {
    const response = await charge('not-a-uuid', nextCycle(), nextKey());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('rejects a non-calendar cycle with 400', async () => {
    const subscriptionId = await createSubscription();

    const response = await charge(subscriptionId, '2026-02-30', nextKey());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
