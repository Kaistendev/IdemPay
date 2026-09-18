import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { CHARGE_EXECUTOR } from '../src/charge-executor/charge-executor.constants';
import type { ChargeExecutorPort } from '../src/charge-executor/charge-executor.types';
import { buildProviderOperationId } from '../src/gateway/provider-operation-id';
import { PG_POOL } from '../src/health/health.constants';

describe('charge executor (e2e)', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorPort;
  const createdSubscriptions: string[] = [];
  let providerCounter = 0;

  const nextProviderOperation = (): string => {
    providerCounter += 1;
    return `t16-po-${providerCounter}`;
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
    status = 'SCHEDULED',
    settledAt: string | null = null,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency,
          status, settled_at)
       VALUES ($1, $2, $3::date, 100, 'USD', $4, $5)
       RETURNING id`,
      [subscriptionId, '2026-05-10', '2026-05-10', status, settledAt],
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
         (billing_intent_id, attempt_no, provider_operation_id, status,
          error_type, finished_at)
       VALUES ($1, $2, $3, $4, NULL, $5)
       RETURNING id`,
      [intentId, attemptNo, nextProviderOperation(), status, finishedAt],
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

  it('takes a SCHEDULED intent to IN_FLIGHT and registers the attempt', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const result = await executor.startAttempt(intentId);

    expect(result).toMatchObject({
      outcome: 'STARTED',
      billingIntentId: intentId,
      attemptNo: 1,
      providerOperationId: buildProviderOperationId(intentId, 1),
    });
    expect(await intentStatus(intentId)).toBe('IN_FLIGHT');

    const { rows } = await pool.query<{
      attemptNo: number;
      providerOperationId: string;
      status: string;
      finishedAt: Date | null;
    }>(
      `SELECT attempt_no AS "attemptNo",
              provider_operation_id AS "providerOperationId",
              status, finished_at AS "finishedAt"
       FROM payment_attempts WHERE billing_intent_id = $1`,
      [intentId],
    );
    expect(rows).toEqual([
      {
        attemptNo: 1,
        providerOperationId: buildProviderOperationId(intentId, 1),
        status: 'IN_FLIGHT',
        finishedAt: null,
      },
    ]);
  });

  it('rejects a second execution while an attempt is IN_FLIGHT', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId, 'IN_FLIGHT');
    await createAttempt(intentId, 1, 'IN_FLIGHT', null);

    const result = await executor.startAttempt(intentId);

    expect(result).toEqual({
      outcome: 'ALREADY_IN_FLIGHT',
      billingIntentId: intentId,
    });
    expect(await attemptCount(intentId)).toBe(1);
  });

  it('lets only one attempt advance when two executions race', async () => {
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
    expect(first.billingIntentId).toBe(intentId);
    expect(second.billingIntentId).toBe(intentId);
    expect(await attemptCount(intentId)).toBe(1);
    expect(await intentStatus(intentId)).toBe('IN_FLIGHT');

    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_attempts
       WHERE billing_intent_id = $1 AND status = 'IN_FLIGHT'`,
      [intentId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('returns NOT_FOUND for an unknown intent', async () => {
    const result = await executor.startAttempt(
      '00000000-0000-0000-0000-000000000000',
    );

    expect(result).toEqual({
      outcome: 'NOT_FOUND',
      billingIntentId: '00000000-0000-0000-0000-000000000000',
    });
  });

  it('does not start an attempt for a terminal intent', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(
      subscriptionId,
      'SUCCEEDED',
      '2026-05-10T12:00:00Z',
    );

    const result = await executor.startAttempt(intentId);

    expect(result).toEqual({
      outcome: 'NOT_SCHEDULED',
      billingIntentId: intentId,
      status: 'SUCCEEDED',
    });
    expect(await attemptCount(intentId)).toBe(0);
  });

  it('refuses to register a sixth attempt', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);
    for (let attemptNo = 1; attemptNo <= 5; attemptNo += 1) {
      await createAttempt(
        intentId,
        attemptNo,
        'FAILED',
        '2026-05-10T12:00:00Z',
      );
    }

    const result = await executor.startAttempt(intentId);

    expect(result).toEqual({
      outcome: 'ATTEMPTS_EXHAUSTED',
      billingIntentId: intentId,
      attempts: 5,
    });
    expect(await attemptCount(intentId)).toBe(5);
    expect(await intentStatus(intentId)).toBe('SCHEDULED');
  });
});
