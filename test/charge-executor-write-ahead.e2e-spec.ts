import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { CHARGE_EXECUTOR } from '../src/charge-executor/charge-executor.constants';
import type { ChargeExecutorPort } from '../src/charge-executor/charge-executor.types';
import { buildProviderOperationId } from '../src/gateway/provider-operation-id';
import { PG_POOL } from '../src/health/health.constants';

describe('charge executor write-ahead (e2e)', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorPort;
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
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{
      id: string;
      attemptNo: number;
      providerOperationId: string;
      status: string;
      startedAt: Date;
      deadlineAt: Date | null;
      finishedAt: Date | null;
    }>(
      `SELECT id,
              auto_seq AS "attemptNo",
              provider_operation_id AS "providerOperationId",
              status, started_at AS "startedAt",
              deadline_at AS "deadlineAt", finished_at AS "finishedAt"
       FROM payment_attempts WHERE billing_intent_id = $1`,
      [intentId],
    );
    return rows;
  };

  const inFlightCount = async (intentId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_attempts
       WHERE billing_intent_id = $1 AND status = 'IN_FLIGHT'`,
      [intentId],
    );
    return rows[0].count;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    pool = moduleRef.get<Pool>(PG_POOL);
    executor = moduleRef.get<ChargeExecutorPort>(CHARGE_EXECUTOR);
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
    await moduleRef.close();
  });

  it('commits step 1 (write-ahead) so a crash leaves the attempt IN_FLIGHT with its id persisted', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const started = await executor.startAttempt(intentId);

    expect(started).toMatchObject({
      outcome: 'STARTED',
      billingIntentId: intentId,
    });
    if (started.outcome !== 'STARTED') {
      throw new Error('Expected the write-ahead attempt to start');
    }

    const attempts = await readAttempts(intentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: started.attemptId,
      attemptNo: 1,
      providerOperationId: buildProviderOperationId(intentId, 1),
      status: 'IN_FLIGHT',
      finishedAt: null,
    });
    expect(attempts[0].deadlineAt).toBeInstanceOf(Date);
    expect(attempts[0].deadlineAt > attempts[0].startedAt).toBe(true);

    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM billing_intents WHERE id = $1',
      [intentId],
    );
    expect(rows[0].status).toBe('IN_FLIGHT');
  });

  it('keeps the write-ahead durable when a fresh execution sees the crash state // T61: @RF-13 @INV-04', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const started = await executor.startAttempt(intentId);

    expect(started).toMatchObject({
      outcome: 'STARTED',
      billingIntentId: intentId,
    });
    if (started.outcome !== 'STARTED') {
      throw new Error('Expected the write-ahead attempt to start');
    }

    const retried = await executor.startAttempt(intentId);

    expect(retried).toEqual({
      outcome: 'ALREADY_IN_FLIGHT',
      billingIntentId: intentId,
    });
    expect(await inFlightCount(intentId)).toBe(1);

    const attempts = await readAttempts(intentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(started.attemptId);
    expect(attempts[0].status).toBe('IN_FLIGHT');
    expect(attempts[0].providerOperationId).toBe(started.providerOperationId);
  });

  it('lets only one transaction advance on simultaneous executions over the same intent // T61: @RF-13 @INV-03', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const [first, second] = await Promise.all([
      executor.startAttempt(intentId),
      executor.startAttempt(intentId),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual([
      'ALREADY_IN_FLIGHT',
      'STARTED',
    ]);
    expect(await inFlightCount(intentId)).toBe(1);
    expect(await readAttempts(intentId)).toHaveLength(1);
  });
});
