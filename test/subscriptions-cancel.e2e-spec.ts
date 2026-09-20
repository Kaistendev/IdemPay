import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyLockKey } from '../src/idempotency/idempotency.constants';
import type { SubscriptionDetailResponse } from '../src/subscriptions/subscriptions.types';

const isoDaysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('subscriptions cancel (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  const runId = `t12-${process.pid}-${Date.now()}`;
  const createdSubscriptions: string[] = [];
  const createdKeys: string[] = [];
  let keyCounter = 0;
  let providerCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    const key = `${runId}-${keyCounter}`;
    createdKeys.push(idempotencyLockKey(key));
    return key;
  };

  const nextProviderOperation = (): string => {
    providerCounter += 1;
    return `t12-po-${providerCounter}`;
  };

  const createSubscription = async (
    status = 'ACTIVE',
    anchorDate = isoDaysFromToday(10),
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status, cancelled_at)
       VALUES (100, 'USD', 'monthly', $1, 'UTC', $2,
               CASE WHEN $2 = 'CANCELLED' THEN now() ELSE NULL END)
       RETURNING id`,
      [anchorDate, status],
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const createIntent = async (
    subscriptionId: string,
    cycle: string,
    status: string,
    settledAt: string | null,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency,
          status, settled_at)
       VALUES ($1, $2, $3::date, 100, 'USD', $4, $5)
       RETURNING id`,
      [subscriptionId, cycle, cycle, status, settledAt],
    );
    return rows[0].id;
  };

  const createAttempt = async (
    intentId: string,
    attemptNo: number,
    status: string,
    finishedAt: string | null,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status,
          error_type, finished_at)
       VALUES ($1, 'AUTO', $2, $3, $4, NULL, $5)
       RETURNING id`,
      [intentId, attemptNo, nextProviderOperation(), status, finishedAt],
    );
    return rows[0].id;
  };

  const cancel = (subscriptionId: string, key: string) =>
    request(app.getHttpServer())
      .post(`/subscriptions/${subscriptionId}/cancel`)
      .set('Idempotency-Key', key);

  const intentStatuses = async (
    subscriptionId: string,
  ): Promise<Record<string, string>> => {
    const { rows } = await pool.query<{ billingCycle: string; status: string }>(
      `SELECT billing_cycle AS "billingCycle", status
       FROM billing_intents WHERE subscription_id = $1`,
      [subscriptionId],
    );
    return Object.fromEntries(
      rows.map((row) => [row.billingCycle, row.status]),
    );
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
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

  it('cancels the subscription and omits the pending intents', async () => {
    const subscriptionId = await createSubscription();
    await createIntent(
      subscriptionId,
      '2026-04-10',
      'SUCCEEDED',
      '2026-04-10T12:00:00Z',
    );
    await createIntent(subscriptionId, '2026-05-10', 'SCHEDULED', null);

    const response = await cancel(subscriptionId, nextKey());

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;
    expect(body).toMatchObject({ id: subscriptionId, status: 'CANCELLED' });
    expect(body.nextBillingDate).toBeNull();
    expect(typeof body.cancelledAt).toBe('string');

    const statuses = await intentStatuses(subscriptionId);
    expect(statuses).toEqual({
      '2026-04-10': 'SUCCEEDED',
      '2026-05-10': 'OMITTED',
    });

    const omitted = body.billingIntents.find(
      (intent) => intent.billingCycle === '2026-05-10',
    );
    expect(omitted).toMatchObject({ status: 'OMITTED' });
    expect(typeof omitted?.settledAt).toBe('string');

    const persisted = await pool.query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    expect(persisted.rows[0].status).toBe('CANCELLED');
  });

  it('keeps an IN_FLIGHT attempt and lets it finish after cancellation', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(
      subscriptionId,
      '2026-05-10',
      'IN_FLIGHT',
      null,
    );
    const attemptId = await createAttempt(intentId, 1, 'IN_FLIGHT', null);

    const response = await cancel(subscriptionId, nextKey());

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;
    expect(body.status).toBe('CANCELLED');
    expect(body.billingIntents[0]).toMatchObject({ status: 'IN_FLIGHT' });
    expect(body.billingIntents[0].attempts[0]).toMatchObject({
      status: 'IN_FLIGHT',
      finishedAt: null,
    });

    await pool.query(
      `UPDATE billing_intents SET status = 'SUCCEEDED', settled_at = now()
       WHERE id = $1`,
      [intentId],
    );
    await pool.query(
      `UPDATE payment_attempts SET status = 'SUCCEEDED', finished_at = now()
       WHERE id = $1`,
      [attemptId],
    );

    const after = await request(app.getHttpServer()).get(
      `/subscriptions/${subscriptionId}`,
    );
    const afterBody = after.body as SubscriptionDetailResponse;
    expect(afterBody.status).toBe('CANCELLED');
    expect(afterBody.billingIntents[0]).toMatchObject({ status: 'SUCCEEDED' });
    expect(afterBody.billingIntents[0].attempts[0]).toMatchObject({
      status: 'SUCCEEDED',
    });
  });

  it('replays the settled response for a repeated idempotency key', async () => {
    const subscriptionId = await createSubscription();
    await createIntent(subscriptionId, '2026-05-10', 'SCHEDULED', null);
    const key = nextKey();

    const first = await cancel(subscriptionId, key);
    const second = await cancel(subscriptionId, key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const omitted = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM billing_intents
       WHERE subscription_id = $1 AND status = 'OMITTED'`,
      [subscriptionId],
    );
    expect(omitted.rows[0].count).toBe(1);
  });

  it('does not change an existing cancellation when called with a new key', async () => {
    const subscriptionId = await createSubscription();

    const first = await cancel(subscriptionId, nextKey());
    const second = await cancel(subscriptionId, nextKey());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = first.body as SubscriptionDetailResponse;
    const secondBody = second.body as SubscriptionDetailResponse;
    expect(secondBody.status).toBe('CANCELLED');
    expect(secondBody.cancelledAt).toBe(firstBody.cancelledAt);
  });

  it('cancels a PAUSED subscription', async () => {
    const subscriptionId = await createSubscription('PAUSED');

    const response = await cancel(subscriptionId, nextKey());

    expect(response.status).toBe(200);
    expect((response.body as SubscriptionDetailResponse).status).toBe(
      'CANCELLED',
    );
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await cancel(
      '00000000-0000-0000-0000-000000000000',
      nextKey(),
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('requires an Idempotency-Key', async () => {
    const subscriptionId = await createSubscription();

    const response = await request(app.getHttpServer()).post(
      `/subscriptions/${subscriptionId}/cancel`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('rejects a malformed subscription id with 400', async () => {
    const response = await cancel('not-a-uuid', nextKey());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"id"');
  });
});
