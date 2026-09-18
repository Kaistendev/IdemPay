import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/health/health.constants';

interface PaymentAttemptResponse {
  id: string;
  attemptNo: number;
  providerOperationId: string;
  status: string;
  errorType: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface BillingIntentResponse {
  id: string;
  billingCycle: string;
  scheduleDate: string;
  amount: number;
  currency: string;
  status: string;
  settledAt: string | null;
  createdAt: string;
  attempts: PaymentAttemptResponse[];
}

interface SubscriptionDetailResponse {
  id: string;
  amount: number;
  currency: string;
  frequency: string;
  startDate: string;
  timezone: string;
  status: string;
  nextBillingDate: string | null;
  createdAt: string;
  cancelledAt: string | null;
  billingIntents: BillingIntentResponse[];
}

const isoDaysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('subscriptions query (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  const createdSubscriptions: string[] = [];
  let providerCounter = 0;

  const nextProviderOperation = (): string => {
    providerCounter += 1;
    return `t11-po-${providerCounter}`;
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
    errorType: string | null,
    finishedAt: string | null,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO payment_attempts
         (billing_intent_id, attempt_no, provider_operation_id, status,
          error_type, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        intentId,
        attemptNo,
        nextProviderOperation(),
        status,
        errorType,
        finishedAt,
      ],
    );
    return rows[0].id;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
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
    await app.close();
  });

  it('returns status, next billing date and the full history', async () => {
    const anchorDate = isoDaysFromToday(10);
    const subscriptionId = await createSubscription('ACTIVE', anchorDate);

    const settledIntent = await createIntent(
      subscriptionId,
      '2026-04-10',
      'SUCCEEDED',
      '2026-04-10T12:00:00Z',
    );
    await createAttempt(
      settledIntent,
      1,
      'SUCCEEDED',
      null,
      '2026-04-10T12:00:05Z',
    );

    const failedIntent = await createIntent(
      subscriptionId,
      '2026-05-10',
      'FAILED_FINAL',
      '2026-05-12T12:00:00Z',
    );
    await createAttempt(
      failedIntent,
      1,
      'FAILED',
      'DECLINED',
      '2026-05-10T12:00:05Z',
    );
    await createAttempt(
      failedIntent,
      2,
      'FAILED',
      'PROVIDER_ERROR',
      '2026-05-11T12:00:05Z',
    );

    const response = await request(app.getHttpServer()).get(
      `/subscriptions/${subscriptionId}`,
    );

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;

    expect(body).toMatchObject({
      id: subscriptionId,
      amount: 100,
      currency: 'USD',
      frequency: 'monthly',
      startDate: anchorDate,
      timezone: 'UTC',
      status: 'ACTIVE',
      nextBillingDate: anchorDate,
      cancelledAt: null,
    });

    expect(body.billingIntents).toHaveLength(2);
    expect(body.billingIntents.map((intent) => intent.billingCycle)).toEqual([
      '2026-04-10',
      '2026-05-10',
    ]);

    const [success, failure] = body.billingIntents;
    expect(success).toMatchObject({
      status: 'SUCCEEDED',
      amount: 100,
      currency: 'USD',
      settledAt: '2026-04-10T12:00:00.000Z',
    });
    expect(success.attempts).toHaveLength(1);
    expect(success.attempts[0]).toMatchObject({
      attemptNo: 1,
      status: 'SUCCEEDED',
      errorType: null,
    });

    expect(failure).toMatchObject({
      status: 'FAILED_FINAL',
      settledAt: '2026-05-12T12:00:00.000Z',
    });
    expect(failure.attempts.map((attempt) => attempt.attemptNo)).toEqual([
      1, 2,
    ]);
    expect(failure.attempts.map((attempt) => attempt.errorType)).toEqual([
      'DECLINED',
      'PROVIDER_ERROR',
    ]);
  });

  it('returns an empty history when the subscription has no billing intents', async () => {
    const subscriptionId = await createSubscription();

    const response = await request(app.getHttpServer()).get(
      `/subscriptions/${subscriptionId}`,
    );

    expect(response.status).toBe(200);
    expect(
      (response.body as SubscriptionDetailResponse).billingIntents,
    ).toEqual([]);
  });

  it('omits the next billing date for a CANCELLED subscription', async () => {
    const subscriptionId = await createSubscription('CANCELLED');

    const response = await request(app.getHttpServer()).get(
      `/subscriptions/${subscriptionId}`,
    );

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;
    expect(body.status).toBe('CANCELLED');
    expect(body.nextBillingDate).toBeNull();
    expect(typeof body.cancelledAt).toBe('string');
  });

  it('omits the next billing date for a PAUSED subscription', async () => {
    const subscriptionId = await createSubscription('PAUSED');

    const response = await request(app.getHttpServer()).get(
      `/subscriptions/${subscriptionId}`,
    );

    expect(response.status).toBe(200);
    const body = response.body as SubscriptionDetailResponse;
    expect(body.status).toBe('PAUSED');
    expect(body.nextBillingDate).toBeNull();
  });

  it('returns 404 for an unknown subscription', async () => {
    const response = await request(app.getHttpServer()).get(
      '/subscriptions/00000000-0000-0000-0000-000000000000',
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('rejects a malformed subscription id with 400', async () => {
    const response = await request(app.getHttpServer()).get(
      '/subscriptions/not-a-uuid',
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"id"');
  });
});
