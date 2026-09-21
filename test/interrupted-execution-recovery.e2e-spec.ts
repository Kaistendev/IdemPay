import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { CHARGE_EXECUTOR } from '../src/charge-executor/charge-executor.constants';
import { RECOVERY_SWEEP_INTERVAL } from '../src/charge-executor/charge-recovery.interval';
import type { ChargeExecutorPort } from '../src/charge-executor/charge-executor.types';
import type { InterruptedExecutionRecoveryPort } from '../src/charge-executor/interrupted-execution.types';
import { PG_POOL } from '../src/health/health.constants';

describe('interrupted execution recovery (e2e)', () => {
  const createdSubscriptions: string[] = [];

  const createSubscription = (pool: Pool): Promise<string> =>
    pool
      .query<{ id: string }>(
        `INSERT INTO subscriptions
           (amount, currency, frequency, anchor_date, timezone, status)
         VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', 'ACTIVE')
         RETURNING id`,
      )
      .then(({ rows }) => {
        createdSubscriptions.push(rows[0].id);
        return rows[0].id;
      });

  const createIntent = (pool: Pool, subscriptionId: string): Promise<string> =>
    pool
      .query<{ id: string }>(
        `INSERT INTO billing_intents
           (subscription_id, billing_cycle, schedule_date, amount, currency, status)
         VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'SCHEDULED')
         RETURNING id`,
        [subscriptionId],
      )
      .then(({ rows }) => rows[0].id);

  const readAttempt = (pool: Pool, attemptId: string) =>
    pool.query<{
      status: string;
      finishedAt: Date | null;
    }>(
      `SELECT status, finished_at AS "finishedAt"
       FROM payment_attempts WHERE id = $1`,
      [attemptId],
    );

  const readIntentStatus = (pool: Pool, intentId: string): Promise<string> =>
    pool
      .query<{ status: string }>(
        'SELECT status FROM billing_intents WHERE id = $1',
        [intentId],
      )
      .then(({ rows }) => rows[0].status);

  const expireAttempt = (pool: Pool, attemptId: string): Promise<void> =>
    pool.query(
      `UPDATE payment_attempts SET deadline_at = now() - interval '1 second'
       WHERE id = $1`,
      [attemptId],
    );

  const cleanupRows = async (pool: Pool) => {
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

  describe('recovery on expired deadline', () => {
    let moduleRef: TestingModule;
    let pool: Pool;
    let executor: ChargeExecutorPort;
    let recovery: InterruptedExecutionRecoveryPort;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get<ChargeExecutorPort>(CHARGE_EXECUTOR);
      recovery = moduleRef.get<InterruptedExecutionRecoveryPort>(
        'INTERRUPTED_EXECUTION_RECOVERY',
      );
    });

    afterAll(async () => {
      await cleanupRows(pool);
      await moduleRef.close();
    });

    it('turns a write-ahead attempt UNKNOWN once its deadline passes', async () => {
      const subscriptionId = await createSubscription(pool);
      const intentId = await createIntent(pool, subscriptionId);

      const started = await executor.startAttempt(intentId);
      if (started.outcome !== 'STARTED') {
        throw new Error('Expected the write-ahead attempt to start');
      }
      await expireAttempt(pool, started.attemptId);

      const recovered = await recovery.recoverExpired();

      expect(recovered).toEqual([
        {
          attemptId: started.attemptId,
          billingIntentId: intentId,
          providerOperationId: started.providerOperationId,
        },
      ]);

      const attempt = await readAttempt(pool, started.attemptId);
      expect(attempt.rows[0].status).toBe('UNKNOWN');
      expect(attempt.rows[0].finishedAt).toBeInstanceOf(Date);
      expect(await readIntentStatus(pool, intentId)).toBe('UNKNOWN');
    });

    it('leaves a non-expired IN_FLIGHT attempt untouched', async () => {
      const subscriptionId = await createSubscription(pool);
      const intentId = await createIntent(pool, subscriptionId);

      const started = await executor.startAttempt(intentId);
      if (started.outcome !== 'STARTED') {
        throw new Error('Expected the write-ahead attempt to start');
      }

      const recovered = await recovery.recoverExpired();

      expect(recovered).toEqual([]);
      const attempt = await readAttempt(pool, started.attemptId);
      expect(attempt.rows[0].status).toBe('IN_FLIGHT');
      expect(attempt.rows[0].finishedAt).toBeNull();
      expect(await readIntentStatus(pool, intentId)).toBe('IN_FLIGHT');
    });
  });

  describe('periodic sweep without manual intervention', () => {
    let moduleRef: TestingModule;
    let app: INestApplication;
    let pool: Pool;
    let executor: ChargeExecutorPort;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(RECOVERY_SWEEP_INTERVAL)
        .useValue(50)
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0);
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get<ChargeExecutorPort>(CHARGE_EXECUTOR);
    });

    afterAll(async () => {
      await cleanupRows(pool);
      await app.close();
    });

    it('recovers the expired attempt by itself', async () => {
      const subscriptionId = await createSubscription(pool);
      const intentId = await createIntent(pool, subscriptionId);

      const started = await executor.startAttempt(intentId);
      if (started.outcome !== 'STARTED') {
        throw new Error('Expected the write-ahead attempt to start');
      }
      await expireAttempt(pool, started.attemptId);

      await new Promise((resolve) => setTimeout(resolve, 250));

      const attempt = await readAttempt(pool, started.attemptId);
      expect(attempt.rows[0].status).toBe('UNKNOWN');
      expect(attempt.rows[0].finishedAt).toBeInstanceOf(Date);
      expect(await readIntentStatus(pool, intentId)).toBe('UNKNOWN');
    });
  });
});
