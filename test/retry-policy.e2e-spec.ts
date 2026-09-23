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

describe('retry policy (e2e)', () => {
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

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{
      status: string;
      settledAt: Date | null;
      nextAttemptAt: Date | null;
    }>(
      `SELECT status, settled_at AS "settledAt", next_attempt_at AS "nextAttemptAt"
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
      providerOperationId: string;
    }>(
      `SELECT auto_seq AS "attemptNo", status, error_type AS "errorType",
              provider_operation_id AS "providerOperationId"
       FROM payment_attempts WHERE billing_intent_id = $1
       ORDER BY auto_seq`,
      [intentId],
    );
    return rows;
  };

  const countIdempotencyOps = async (intentId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM idempotency_operations
       WHERE billing_intent_id = $1`,
      [intentId],
    );
    return rows[0].count;
  };

  const intentCount = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM billing_intents
       WHERE subscription_id = $1`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const cleanup = async () => {
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
      createdSubscriptions.length = 0;
    }
  };

  describe('with five retryable provider failures', () => {
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

    it('retries four times with backoff and finishes FAILED_FINAL on the fifth // T58: @E2E-08 @RF-19 @RF-21', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);

      const nominalWaits = [10_000, 20_000, 40_000, 80_000];

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const before = Date.now();
        const result = await executor.execute(intentId);

        expect(result).toMatchObject({
          outcome: 'RETRY_PENDING',
          billingIntentId: intentId,
          attemptNo: attempt,
          errorType: 'PROVIDER_ERROR',
        });
        if ('nextAttemptAt' in result) {
          const delta = result.nextAttemptAt.getTime() - before;
          expect(delta).toBeGreaterThanOrEqual(0.8 * nominalWaits[attempt - 1]);
          expect(delta).toBeLessThanOrEqual(
            1.2 * nominalWaits[attempt - 1] + 500,
          );
        }

        const intent = await readIntent(intentId);
        expect(intent.status).toBe('RETRY_PENDING');
        expect(intent.settledAt).toBeNull();
        expect(intent.nextAttemptAt).toBeInstanceOf(Date);

        const attempts = await readAttempts(intentId);
        expect(attempts).toHaveLength(attempt);
        expect(attempts[attempt - 1]).toMatchObject({
          attemptNo: attempt,
          status: 'FAILED',
          errorType: 'PROVIDER_ERROR',
        });

        await makeIntentDue(pool, intentId);
      }

      const final = await executor.execute(intentId);

      expect(final).toMatchObject({
        outcome: 'FAILED_FINAL',
        billingIntentId: intentId,
        attemptNo: 5,
        errorType: 'PROVIDER_ERROR',
      });

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('FAILED_FINAL');
      expect(intent.settledAt).toBeInstanceOf(Date);

      const attempts = await readAttempts(intentId);
      expect(attempts).toHaveLength(5);
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({
          status: 'FAILED',
          errorType: 'PROVIDER_ERROR',
        });
      }

      expect(attempts.map((attempt) => attempt.providerOperationId)).toEqual([
        `${intentId}:1`,
        `${intentId}:2`,
        `${intentId}:3`,
        `${intentId}:4`,
        `${intentId}:5`,
      ]);
      expect(await countIdempotencyOps(intentId)).toBe(0);

      const afterFinal = await executor.execute(intentId);
      expect(afterFinal).toMatchObject({
        outcome: 'NOT_STARTED',
        reason: 'NOT_SCHEDULED',
      });
      expect(await readAttempts(intentId)).toHaveLength(5);
      expect(await intentCount(subscriptionId)).toBe(1);
    });
  });

  describe('with a declined payment', () => {
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

    it('finishes FAILED_FINAL on the first attempt without scheduling a retry // T58: @E2E-09 @RF-20 @RF-21', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);

      const result = await executor.execute(intentId);

      expect(result).toMatchObject({
        outcome: 'FAILED_FINAL',
        billingIntentId: intentId,
        attemptNo: 1,
        errorType: 'DECLINED',
      });

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('FAILED_FINAL');
      expect(intent.settledAt).toBeInstanceOf(Date);
      expect(intent.nextAttemptAt).toBeNull();

      const attempts = await readAttempts(intentId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNo: 1,
        status: 'FAILED',
        errorType: 'DECLINED',
      });
      expect(attempts[0].providerOperationId).toBe(`${intentId}:1`);
      expect(await countIdempotencyOps(intentId)).toBe(0);

      const second = await executor.execute(intentId);
      expect(second).toMatchObject({
        outcome: 'NOT_STARTED',
        reason: 'NOT_SCHEDULED',
      });
      expect(await readAttempts(intentId)).toHaveLength(1);
      expect(await intentCount(subscriptionId)).toBe(1);
    });
  });
});
