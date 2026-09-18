import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ChargeExecutorService } from '../src/charge-executor/charge-executor.service';
import { MockPaymentAdapter } from '../src/gateway/mock-payment.adapter';
import { PAYMENT_SCENARIO } from '../src/gateway/payment-scenario';
import { PG_POOL } from '../src/health/health.constants';

const scenarioOf = (scenario: string) =>
  Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_SCENARIO)
    .useValue(scenario);

describe('charge confirmation (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorService;
  let gateway: MockPaymentAdapter;
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
    }>(
      `SELECT status, settled_at AS "settledAt" FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{
      attemptNo: number;
      providerOperationId: string;
      status: string;
      errorType: string | null;
      finishedAt: Date | null;
    }>(
      `SELECT attempt_no AS "attemptNo",
              provider_operation_id AS "providerOperationId",
              status, error_type AS "errorType", finished_at AS "finishedAt"
       FROM payment_attempts WHERE billing_intent_id = $1
       ORDER BY attempt_no`,
      [intentId],
    );
    return rows;
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

  describe('with a confirmed success', () => {
    beforeAll(async () => {
      moduleRef = await scenarioOf('SUCCESS').compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get(ChargeExecutorService);
      gateway = moduleRef.get(MockPaymentAdapter);
    });

    afterAll(async () => {
      await cleanup();
      await app.close();
    });

    it('settles the attempt and the intent as SUCCEEDED', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);

      const result = await executor.execute(intentId);

      expect(result).toMatchObject({
        outcome: 'SUCCEEDED',
        billingIntentId: intentId,
        attemptNo: 1,
      });

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.settledAt).toBeInstanceOf(Date);

      const attempts = await readAttempts(intentId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attemptNo: 1,
        status: 'SUCCEEDED',
        errorType: null,
      });
      expect(attempts[0].finishedAt).toBeInstanceOf(Date);
    });

    it('never executes the adapter again for a SUCCEEDED intent', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);

      const first = await executor.execute(intentId);
      const executionsAfterFirst = gateway.executedChargeCount();
      const second = await executor.execute(intentId);

      expect(first.outcome).toBe('SUCCEEDED');
      expect(second).toEqual({
        outcome: 'NOT_STARTED',
        billingIntentId: intentId,
        reason: 'NOT_SCHEDULED',
      });
      expect(gateway.executedChargeCount()).toBe(executionsAfterFirst);
      expect(await readAttempts(intentId)).toHaveLength(1);
    });
  });

  describe('without a verifiable confirmation', () => {
    beforeAll(async () => {
      moduleRef = await scenarioOf('TIMEOUT').compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get(ChargeExecutorService);
    });

    afterAll(async () => {
      await cleanup();
      await app.close();
    });

    it('does not mark success and leaves the intent UNKNOWN', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);

      const result = await executor.execute(intentId);

      expect(result).toMatchObject({ outcome: 'UNKNOWN', attemptNo: 1 });

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('UNKNOWN');
      expect(intent.settledAt).toBeNull();

      const attempts = await readAttempts(intentId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: 'UNKNOWN' });
      expect(attempts[0].finishedAt).toBeInstanceOf(Date);
    });

    it('does not re-execute an UNKNOWN intent without verification', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createIntent(subscriptionId);
      await executor.execute(intentId);

      const second = await executor.execute(intentId);

      expect(second).toMatchObject({
        outcome: 'NOT_STARTED',
        reason: 'NOT_SCHEDULED',
      });
      expect(await readAttempts(intentId)).toHaveLength(1);
    });
  });
});
