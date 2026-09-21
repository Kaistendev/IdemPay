import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import type { App } from 'supertest/types';
import { ChargeDispatcherService } from '../src/dispatcher/charge-dispatcher.service';
import { ChargeExecutionWorker } from '../src/dispatcher/charge-execution-worker';
import { DispatcherModule } from '../src/dispatcher/dispatcher.module';
import { CHARGE_DISPATCH_INTERVAL } from '../src/dispatcher/dispatch.config';
import type { ChargeDispatchRepositoryPort } from '../src/dispatcher/dispatch.types';
import { DISPATCH_REPOSITORY } from '../src/dispatcher/queue.constants';
import { PAYMENT_SCENARIO } from '../src/gateway/payment-scenario';
import { PG_POOL } from '../src/health/health.constants';

const LONG_INTERVAL_MS = 60_000;

const moduleFor = () =>
  Test.createTestingModule({ imports: [DispatcherModule] })
    .overrideProvider(PAYMENT_SCENARIO)
    .useValue('SUCCESS')
    .overrideProvider(CHARGE_DISPATCH_INTERVAL)
    .useValue(LONG_INTERVAL_MS);

describe('dispatcher to BullMQ (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let repository: ChargeDispatchRepositoryPort;
  let dispatcher: ChargeDispatcherService;
  let worker: ChargeExecutionWorker;
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

  const createDueIntent = async (subscriptionId: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency,
          status, next_attempt_at)
       VALUES ($1, '2026-05-10', '2026-05-10'::date, 100, 'USD',
               'SCHEDULED', now() - interval '1 second')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const intentStatus = async (intentId: string): Promise<string> => {
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM billing_intents WHERE id = $1',
      [intentId],
    );
    return rows[0].status;
  };

  const attemptCount = async (intentId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_attempts
       WHERE billing_intent_id = $1`,
      [intentId],
    );
    return rows[0].count;
  };

  const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
    const timeoutAt = Date.now() + 5_000;
    while (Date.now() < timeoutAt) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('timed out waiting for the worker to charge the intent');
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

  describe('a job lost between commit and enqueue', () => {
    beforeAll(async () => {
      moduleRef = await moduleFor().compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      pool = moduleRef.get<Pool>(PG_POOL);
      repository = moduleRef.get(DISPATCH_REPOSITORY);
      dispatcher = moduleRef.get(ChargeDispatcherService);
    });

    afterAll(async () => {
      await cleanup();
      await app.close();
    });

    it('is re-picked by the sweep and charged exactly once', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createDueIntent(subscriptionId);

      const picked = await repository.dispatchDue(10);
      expect(picked).toEqual([intentId]);

      const repicked = await repository.dispatchDue(10);
      expect(repicked).toEqual([intentId]);

      await expect(dispatcher.dispatch()).resolves.toBe(1);

      await waitFor(async () => {
        const [status, attempts] = await Promise.all([
          intentStatus(intentId),
          attemptCount(intentId),
        ]);
        return status === 'SUCCEEDED' && attempts === 1;
      });

      expect(await intentStatus(intentId)).toBe('SUCCEEDED');
      expect(await attemptCount(intentId)).toBe(1);
    });
  });

  describe('two duplicate jobs', () => {
    beforeAll(async () => {
      moduleRef = await moduleFor().compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      pool = moduleRef.get<Pool>(PG_POOL);
      worker = moduleRef.get(ChargeExecutionWorker);
    });

    afterAll(async () => {
      await cleanup();
      await app.close();
    });

    it('produce a single payment attempt', async () => {
      const subscriptionId = await createSubscription();
      const intentId = await createDueIntent(subscriptionId);

      await Promise.all([
        worker.executeJob(intentId),
        worker.executeJob(intentId),
      ]);

      const [status, attempts] = await Promise.all([
        intentStatus(intentId),
        attemptCount(intentId),
      ]);
      expect(status).toBe('SUCCEEDED');
      expect(attempts).toBe(1);
    });
  });
});
