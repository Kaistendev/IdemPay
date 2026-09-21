import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { VERIFICATION_SWEEP_INTERVAL } from '../src/charge-executor/charge-verification.interval';
import { ChargeVerificationSweepService } from '../src/charge-executor/charge-verification.sweep.service';
import { ChargeExecutorService } from '../src/charge-executor/charge-executor.service';
import { PAYMENT_GATEWAY } from '../src/gateway/gateway.constants';
import type {
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../src/gateway/gateway.types';
import { PG_POOL } from '../src/health/health.constants';

type SubscriptionState = 'ACTIVE' | 'PAUSED' | 'CANCELLED';

class ScriptedGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;
  private readonly results = new Map<string, VerificationResult>();

  set(providerOperationId: string, result: VerificationResult): void {
    this.results.set(providerOperationId, result);
  }

  reset(): void {
    this.charges = 0;
    this.verifications = 0;
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome: 'SUCCEEDED',
    });
  }

  verify(providerOperationId: string): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve(this.results.get(providerOperationId) ?? 'UNKNOWN');
  }
}

const moduleFor = (gateway: ScriptedGateway) =>
  Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    .overrideProvider(VERIFICATION_SWEEP_INTERVAL)
    .useValue(60_000);

describe('UNKNOWN verification (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let sweep: ChargeVerificationSweepService;
  let executor: ChargeExecutorService;
  let gateway: ScriptedGateway;
  const createdSubscriptions: string[] = [];

  const createSubscription = async (
    status: SubscriptionState,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status, cancelled_at)
       VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', $1,
               CASE WHEN $1 = 'CANCELLED' THEN now() ELSE NULL END)
       RETURNING id`,
      [status],
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const createUnknownIntent = async (
    subscriptionId: string,
    providerOperationId: string,
    attemptNo = 1,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status, unknown_since)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'UNKNOWN', now())
       RETURNING id`,
      [subscriptionId],
    );
    const intentId = rows[0].id;
    await pool.query(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status, started_at, finished_at)
       VALUES ($1, 'AUTO', $2, $3, 'UNKNOWN', now() - interval '1 minute', now())`,
      [intentId, attemptNo, providerOperationId],
    );
    return intentId;
  };

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{
      status: string;
      settledAt: Date | null;
      nextAttemptAt: Date | null;
      omittedReason: string | null;
      verifyCount: number;
    }>(
      `SELECT status,
              settled_at AS "settledAt",
              next_attempt_at AS "nextAttemptAt",
              omitted_reason AS "omittedReason",
              verify_count AS "verifyCount"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{ autoSeq: number }>(
      `SELECT auto_seq AS "autoSeq" FROM payment_attempts
       WHERE billing_intent_id = $1 ORDER BY auto_seq`,
      [intentId],
    );
    return rows;
  };

  const makeRetryDue = async (intentId: string): Promise<void> => {
    await pool.query(
      `UPDATE billing_intents SET next_attempt_at = now() - interval '1 second'
       WHERE id = $1`,
      [intentId],
    );
  };

  const makeVerificationDue = async (intentId: string): Promise<void> => {
    await pool.query(
      `UPDATE billing_intents SET next_verify_at = now() - interval '1 second'
       WHERE id = $1`,
      [intentId],
    );
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

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    moduleRef = await moduleFor(gateway).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    sweep = moduleRef.get(ChargeVerificationSweepService);
    executor = moduleRef.get(ChargeExecutorService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('never calls charge again while verify stays UNKNOWN', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription('ACTIVE');
    const intentId = await createUnknownIntent(subscriptionId, 'op-single');

    gateway.set('op-single', 'UNKNOWN');
    await sweep.verifyUnknown();
    await makeVerificationDue(intentId);
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(2);
    expect(gateway.charges).toBe(0);
  });

  it('closes the intent as SUCCEEDED once verify confirms the charge', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription('ACTIVE');
    const intentId = await createUnknownIntent(subscriptionId, 'op-closed');

    gateway.set('op-closed', 'SUCCEEDED');
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('SUCCEEDED');
    expect(intent.settledAt).toBeInstanceOf(Date);
    expect(gateway.charges).toBe(0);

    const after = await executor.execute(intentId);
    expect(after).toMatchObject({ outcome: 'NOT_STARTED' });
    expect(await readAttempts(intentId)).toHaveLength(1);
  });

  it('reschedules an ACTIVE subscription as RETRY_PENDING after verify FAILED', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription('ACTIVE');
    const intentId = await createUnknownIntent(subscriptionId, 'op-failed');

    gateway.set('op-failed', 'FAILED');
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('RETRY_PENDING');
    expect(intent.nextAttemptAt).toBeInstanceOf(Date);
    expect(intent.verifyCount).toBe(0);
    expect(gateway.charges).toBe(0);

    await makeRetryDue(intentId);
    const retry = await executor.execute(intentId);

    expect(retry).toMatchObject({
      outcome: 'UNKNOWN',
      billingIntentId: intentId,
      attemptNo: 2,
    });
    expect(await readAttempts(intentId)).toHaveLength(2);
    expect(gateway.charges).toBe(1);
  });

  it('omits a CANCELLED subscription intent as OMITTED after verify FAILED', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription('CANCELLED');
    const intentId = await createUnknownIntent(subscriptionId, 'op-cancelled');

    gateway.set('op-cancelled', 'FAILED');
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('OMITTED');
    expect(intent.omittedReason).toBe('SUBSCRIPTION_CANCELLED');
    expect(intent.settledAt).toBeInstanceOf(Date);
    expect(gateway.charges).toBe(0);
  });

  it('omits a PAUSED subscription intent as OMITTED after verify FAILED', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription('PAUSED');
    const intentId = await createUnknownIntent(subscriptionId, 'op-paused');

    gateway.set('op-paused', 'FAILED');
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('OMITTED');
    expect(intent.omittedReason).toBe('SUBSCRIPTION_PAUSED');
    expect(intent.settledAt).toBeInstanceOf(Date);
    expect(gateway.charges).toBe(0);
  });
});

describe('periodic UNKNOWN verification without manual intervention', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let gateway: ScriptedGateway;
  const createdSubscriptions: string[] = [];

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(VERIFICATION_SWEEP_INTERVAL)
      .useValue(50)
      .compile();
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

  it('verifies an UNKNOWN intent on cadence without ever charging it', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-05-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    createdSubscriptions.push(rows[0].id);
    const subscriptionId = rows[0].id;

    const intentResult = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status, unknown_since)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'UNKNOWN', now())
       RETURNING id`,
      [subscriptionId],
    );
    const intentId = intentResult.rows[0].id;
    await pool.query(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status, started_at, finished_at)
       VALUES ($1, 'AUTO', 1, 'op-periodic', 'UNKNOWN', now() - interval '1 minute', now())`,
      [intentId],
    );

    await new Promise((resolve) => setTimeout(resolve, 250));

    const { rows: intentRows } = await pool.query<{
      status: string;
      verifyCount: number;
      nextVerifyAt: Date | null;
    }>(
      `SELECT status, verify_count AS "verifyCount", next_verify_at AS "nextVerifyAt"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    expect(intentRows[0].status).toBe('UNKNOWN');
    expect(intentRows[0].verifyCount).toBe(1);
    expect(intentRows[0].nextVerifyAt).toBeInstanceOf(Date);
    expect(gateway.charges).toBe(0);
    expect(gateway.verifications).toBe(1);
  });
});
