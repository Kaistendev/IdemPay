import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PAYMENT_GATEWAY } from '../src/gateway/gateway.constants';
import type {
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../src/gateway/gateway.types';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyLockKey } from '../src/idempotency/idempotency.constants';

class ScriptedGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;
  defaultOutcome: ChargeOutcome = 'SUCCEEDED';
  defaultVerify: VerificationResult = 'SUCCEEDED';

  private readonly verifies = new Map<string, VerificationResult>();

  reset(): void {
    this.charges = 0;
    this.verifications = 0;
    this.verifies.clear();
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome: this.defaultOutcome,
    });
  }

  verify(providerOperationId: string): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve(
      this.verifies.get(providerOperationId) ?? this.defaultVerify,
    );
  }
}

describe('reprocess (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  let gateway: ScriptedGateway;
  const runId = `t60-${process.pid}-${Date.now()}`;
  const createdSubscriptions: string[] = [];
  const createdKeys: string[] = [];
  const createdOperationKeys: string[] = [];
  let keyCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    const key = `${runId}-${keyCounter}`;
    createdKeys.push(idempotencyLockKey(key));
    createdOperationKeys.push(key);
    return key;
  };

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

  const createIntent = async (
    subscriptionId: string,
    status: string,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status, settled_at)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', $2,
               CASE WHEN $2 IN ('SUCCEEDED', 'FAILED_FINAL') THEN now() ELSE NULL END)
       RETURNING id`,
      [subscriptionId, status],
    );
    return rows[0].id;
  };

  const createAutoAttempt = async (
    intentId: string,
    attemptNo: number,
    status: string,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status, finished_at)
       VALUES ($1, 'AUTO', $2, $3, $4, now())`,
      [intentId, attemptNo, `${intentId}:${attemptNo}`, status],
    );
  };

  const cancel = (subscriptionId: string, key: string) =>
    request(app.getHttpServer())
      .post(`/subscriptions/${subscriptionId}/cancel`)
      .set('Idempotency-Key', key);

  const reprocess = (subscriptionId: string, cycle: string, key: string) =>
    request(app.getHttpServer())
      .post(
        `/subscriptions/${subscriptionId}/billing-cycles/${cycle}/reprocess`,
      )
      .set('Idempotency-Key', key);

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

  const readSubscription = async (subscriptionId: string) => {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{
      trigger: string;
      autoSeq: number | null;
      providerOperationId: string;
      status: string;
    }>(
      `SELECT trigger,
              auto_seq AS "autoSeq",
              provider_operation_id AS "providerOperationId",
              status
       FROM payment_attempts WHERE billing_intent_id = $1
       ORDER BY auto_seq NULLS LAST, started_at`,
      [intentId],
    );
    return rows;
  };

  const countEvents = async (subscriptionId: string) => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications
       WHERE aggregate_id = $1 AND type = 'CancellationEvent'`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const cleanup = async () => {
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
      await pool.query(
        'DELETE FROM notifications WHERE aggregate_id = ANY($1::uuid[])',
        [createdSubscriptions],
      );
      await pool.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [
        createdSubscriptions,
      ]);
    }
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
  };

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('reprocesses a FAILED_FINAL intent with a MANUAL attempt and never reactivates the cancelled subscription // T60: @E2E-14 @RF-29', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId, 'FAILED_FINAL');
    await createAutoAttempt(intentId, 1, 'FAILED');

    const cancelled = await cancel(subscriptionId, nextKey());
    expect(cancelled.status).toBe(200);
    expect(await countEvents(subscriptionId)).toBe(1);

    const response = await reprocess(subscriptionId, '2026-05-10', nextKey());

    expect(response.status).toBe(200);
    const body = response.body as {
      id: string;
      subscriptionId: string;
      billingCycle: string;
      status: string;
      amount: number;
      currency: string;
    };
    expect(body).toMatchObject({
      id: intentId,
      subscriptionId,
      billingCycle: '2026-05-10',
      status: 'SUCCEEDED',
      amount: 100,
      currency: 'USD',
    });

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('SUCCEEDED');
    expect(intent.settledAt).toBeInstanceOf(Date);

    const subscription = await readSubscription(subscriptionId);
    expect(subscription.status).toBe('CANCELLED');
    expect(await countEvents(subscriptionId)).toBe(1);

    const attempts = await readAttempts(intentId);
    expect(attempts).toEqual([
      {
        trigger: 'AUTO',
        autoSeq: 1,
        providerOperationId: `${intentId}:1`,
        status: 'FAILED',
      },
      {
        trigger: 'MANUAL',
        autoSeq: null,
        providerOperationId: `${intentId}:manual:2`,
        status: 'SUCCEEDED',
      },
    ]);
    expect(gateway.charges).toBe(1);
    expect(gateway.verifications).toBe(1);

    const intents = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM billing_intents
       WHERE subscription_id = $1`,
      [subscriptionId],
    );
    expect(intents.rows[0].count).toBe(1);
  });

  it('replays the settled response for a repeated reprocess idempotency key without a second charge // T60: @E2E-14 @RF-29', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId, 'FAILED_FINAL');
    await createAutoAttempt(intentId, 1, 'FAILED');
    await cancel(subscriptionId, nextKey());

    const key = nextKey();
    const first = await reprocess(subscriptionId, '2026-05-10', key);
    const second = await reprocess(subscriptionId, '2026-05-10', key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(gateway.charges).toBe(1);
    expect(await readIntent(intentId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await readSubscription(subscriptionId)).toMatchObject({
      status: 'CANCELLED',
    });
  });

  it('rejects reprocess on a SUCCEEDED intent with 409 REPROCESS_NOT_ELIGIBLE // T60: @E2E-14 @RF-29', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription();
    await createIntent(subscriptionId, 'SUCCEEDED');

    const response = await reprocess(subscriptionId, '2026-05-10', nextKey());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: 'REPROCESS_NOT_ELIGIBLE' });
    expect(gateway.charges).toBe(0);
  });

  it('rejects a malformed cycle with 400', async () => {
    const subscriptionId = await createSubscription();

    const response = await reprocess(subscriptionId, 'not-a-date', nextKey());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"cycle"');
  });
});
