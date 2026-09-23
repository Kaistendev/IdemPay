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

describe('subscriptions resume (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  const runId = `t51-${process.pid}-${Date.now()}`;
  const createdSubscriptions: string[] = [];
  const createdKeys: string[] = [];
  let keyCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    const key = `${runId}-${keyCounter}`;
    createdKeys.push(idempotencyLockKey(key));
    return key;
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
    reason: string | null = null,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency,
          status, omitted_reason, settled_at)
       VALUES ($1, $2, $3::date, 100, 'USD', $4, $5, $6)
       RETURNING id`,
      [subscriptionId, cycle, cycle, status, reason, settledAt],
    );
    return rows[0].id;
  };

  const resume = (subscriptionId: string, key: string) =>
    request(app.getHttpServer())
      .post(`/subscriptions/${subscriptionId}/resume`)
      .set('Idempotency-Key', key);

  const intentRows = async (
    subscriptionId: string,
  ): Promise<Array<{ cycle: string; status: string }>> => {
    const { rows } = await pool.query<{ cycle: string; status: string }>(
      `SELECT billing_cycle AS cycle, status
       FROM billing_intents WHERE subscription_id = $1 ORDER BY billing_cycle`,
      [subscriptionId],
    );
    return rows;
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

  it('resumes a PAUSED subscription to ACTIVE and schedules the next calendar cycle // T60: @E2E-12 @RF-27 @RF-23', async () => {
    const subscriptionId = await createSubscription('PAUSED');
    await createIntent(
      subscriptionId,
      '2026-05-10',
      'OMITTED',
      '2026-05-10T12:00:00Z',
      'SUBSCRIPTION_PAUSED',
    );

    const response = await resume(subscriptionId, nextKey());

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;
    expect(body).toMatchObject({ id: subscriptionId, status: 'ACTIVE' });
    expect(typeof body.nextBillingDate).toBe('string');
    expect(body.nextBillingDate).not.toBeNull();

    const persisted = await pool.query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    expect(persisted.rows[0].status).toBe('ACTIVE');
  });

  it('does not catch up: paused cycles stay OMITTED and no new intent is created // T60: @E2E-12 @RF-27', async () => {
    const subscriptionId = await createSubscription('PAUSED');
    await createIntent(
      subscriptionId,
      '2026-05-10',
      'OMITTED',
      '2026-05-10T12:00:00Z',
      'SUBSCRIPTION_PAUSED',
    );
    await createIntent(
      subscriptionId,
      '2026-04-10',
      'SUCCEEDED',
      '2026-04-10T12:00:00Z',
    );

    const response = await resume(subscriptionId, nextKey());

    expect(response.status).toBe(200);

    const intents = await intentRows(subscriptionId);
    expect(intents).toEqual([
      { cycle: '2026-04-10', status: 'SUCCEEDED' },
      { cycle: '2026-05-10', status: 'OMITTED' },
    ]);
  });

  it('replays the settled response for a repeated idempotency key without a second transition', async () => {
    const subscriptionId = await createSubscription('PAUSED');
    const key = nextKey();

    const first = await resume(subscriptionId, key);
    const second = await resume(subscriptionId, key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const resumptions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM subscriptions
       WHERE id = $1 AND status = 'ACTIVE'`,
      [subscriptionId],
    );
    expect(resumptions.rows[0].count).toBe(1);
  });

  it('returns 409 INVALID_TRANSITION when the subscription is already ACTIVE (new key)', async () => {
    const subscriptionId = await createSubscription('ACTIVE');

    const response = await resume(subscriptionId, nextKey());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'INVALID_TRANSITION' });
  });

  it('returns 409 INVALID_TRANSITION when the subscription is CANCELLED', async () => {
    const subscriptionId = await createSubscription('CANCELLED');

    const response = await resume(subscriptionId, nextKey());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'INVALID_TRANSITION' });
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await resume(
      '00000000-0000-0000-0000-000000000000',
      nextKey(),
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('requires an Idempotency-Key', async () => {
    const subscriptionId = await createSubscription('PAUSED');

    const response = await request(app.getHttpServer()).post(
      `/subscriptions/${subscriptionId}/resume`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('rejects a malformed subscription id with 400', async () => {
    const response = await resume('not-a-uuid', nextKey());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"id"');
  });
});
