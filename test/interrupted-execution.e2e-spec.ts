import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import {
  CHARGE_EXECUTOR,
  INTERRUPTED_EXECUTION_RECOVERY,
} from '../src/charge-executor/charge-executor.constants';
import { ChargeExecutorService } from '../src/charge-executor/charge-executor.service';
import type { ChargeExecutorPort } from '../src/charge-executor/charge-executor.types';
import { EXECUTION_TIMEOUT } from '../src/charge-executor/execution-timeout';
import type { InterruptedExecutionRecoveryPort } from '../src/charge-executor/interrupted-execution.types';
import { PG_POOL } from '../src/health/health.constants';

const withTimeout = (timeoutMs: number) =>
  Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EXECUTION_TIMEOUT)
    .useValue(timeoutMs);

describe('interrupted execution recovery (e2e)', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorPort;
  let recovery: InterruptedExecutionRecoveryPort;
  const createdSubscriptions: string[] = [];

  const createIntent = async (): Promise<{
    subscriptionId: string;
    intentId: string;
  }> => {
    const { rows: subscriptions } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    const subscriptionId = subscriptions[0].id;
    createdSubscriptions.push(subscriptionId);

    const { rows: intents } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10'::date, 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return { subscriptionId, intentId: intents[0].id };
  };

  const readState = async (intentId: string) => {
    const { rows: intents } = await pool.query<{
      status: string;
      settledAt: Date | null;
    }>(
      `SELECT status, settled_at AS "settledAt" FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    const { rows: attempts } = await pool.query<{
      id: string;
      status: string;
      providerOperationId: string;
      finishedAt: Date | null;
    }>(
      `SELECT id, status, provider_operation_id AS "providerOperationId",
              finished_at AS "finishedAt"
       FROM payment_attempts WHERE billing_intent_id = $1`,
      [intentId],
    );
    return { intent: intents[0], attempts };
  };

  const cleanup = async () => {
    if (createdSubscriptions.length === 0) {
      return;
    }
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
  };

  describe('when the execution timeout has expired', () => {
    beforeAll(async () => {
      moduleRef = await withTimeout(0).compile();
      await moduleRef.init();
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get<ChargeExecutorPort>(CHARGE_EXECUTOR);
      recovery = moduleRef.get<InterruptedExecutionRecoveryPort>(
        INTERRUPTED_EXECUTION_RECOVERY,
      );
    });

    afterAll(async () => {
      await cleanup();
      await moduleRef.close();
    });

    it('materializes an interruption as UNKNOWN on the intent and the attempt', async () => {
      const { intentId } = await createIntent();

      const started = await executor.startAttempt(intentId);
      expect(started.outcome).toBe('STARTED');
      if (started.outcome !== 'STARTED') {
        throw new Error('expected a started attempt');
      }

      const before = await readState(intentId);
      expect(before.intent.status).toBe('IN_FLIGHT');
      expect(before.attempts[0]).toMatchObject({
        status: 'IN_FLIGHT',
        finishedAt: null,
      });

      const recovered = await recovery.recoverExpired();

      expect(recovered).toEqual([
        {
          attemptId: started.attemptId,
          billingIntentId: intentId,
          providerOperationId: started.providerOperationId,
        },
      ]);

      const after = await readState(intentId);
      expect(after.intent.status).toBe('UNKNOWN');
      expect(after.intent.settledAt).toBeNull();
      expect(after.attempts[0]).toMatchObject({ status: 'UNKNOWN' });
      expect(after.attempts[0].finishedAt).toBeInstanceOf(Date);
    });

    it('does not recover the same execution twice', async () => {
      const { intentId } = await createIntent();
      await executor.startAttempt(intentId);

      await recovery.recoverExpired();
      const second = await recovery.recoverExpired();

      expect(second).toEqual([]);
      expect((await readState(intentId)).intent.status).toBe('UNKNOWN');
    });

    it('leaves a SUCCEEDED intent untouched', async () => {
      const { intentId } = await createIntent();
      const service = moduleRef.get(ChargeExecutorService);

      const executed = await service.execute(intentId);
      expect(executed.outcome).toBe('SUCCEEDED');

      const recovered = await recovery.recoverExpired();

      expect(recovered).toEqual([]);
      const state = await readState(intentId);
      expect(state.intent.status).toBe('SUCCEEDED');
      expect(state.attempts[0].status).toBe('SUCCEEDED');
    });
  });

  describe('when the execution timeout has not expired', () => {
    beforeAll(async () => {
      moduleRef = await withTimeout(60_000).compile();
      await moduleRef.init();
      pool = moduleRef.get<Pool>(PG_POOL);
      executor = moduleRef.get<ChargeExecutorPort>(CHARGE_EXECUTOR);
      recovery = moduleRef.get<InterruptedExecutionRecoveryPort>(
        INTERRUPTED_EXECUTION_RECOVERY,
      );
    });

    afterAll(async () => {
      await cleanup();
      await moduleRef.close();
    });

    it('keeps a live execution IN_FLIGHT', async () => {
      const { intentId } = await createIntent();
      await executor.startAttempt(intentId);

      const recovered = await recovery.recoverExpired();

      expect(recovered).toEqual([]);
      const state = await readState(intentId);
      expect(state.intent.status).toBe('IN_FLIGHT');
      expect(state.attempts[0]).toMatchObject({
        status: 'IN_FLIGHT',
        finishedAt: null,
      });
    });
  });
});
