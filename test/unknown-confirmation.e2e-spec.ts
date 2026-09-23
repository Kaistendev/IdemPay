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
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../src/gateway/gateway.types';
import { PG_POOL } from '../src/health/health.constants';

class ScriptedGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;
  defaultOutcome: ChargeOutcome = 'TIMEOUT';
  defaultVerify: VerificationResult = 'UNKNOWN';

  private readonly outcomes = new Map<string, ChargeOutcome>();
  private readonly verifies = new Map<string, VerificationResult>();

  setOutcome(providerOperationId: string, outcome: ChargeOutcome): void {
    this.outcomes.set(providerOperationId, outcome);
  }

  setVerify(providerOperationId: string, result: VerificationResult): void {
    this.verifies.set(providerOperationId, result);
  }

  reset(): void {
    this.charges = 0;
    this.verifications = 0;
    this.outcomes.clear();
    this.verifies.clear();
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome:
        this.outcomes.get(request.providerOperationId) ?? this.defaultOutcome,
    });
  }

  verify(providerOperationId: string): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve(
      this.verifies.get(providerOperationId) ?? this.defaultVerify,
    );
  }
}

const moduleFor = (gateway: ScriptedGateway) =>
  Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PAYMENT_GATEWAY)
    .useValue(gateway)
    .overrideProvider(VERIFICATION_SWEEP_INTERVAL)
    .useValue(60_000);

describe('unknown and ambiguous charges (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorService;
  let sweep: ChargeVerificationSweepService;
  let gateway: ScriptedGateway;
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

  const createScheduledIntent = async (subscriptionId: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{
      status: string;
      settledAt: Date | null;
      unknownSince: Date | null;
      nextAttemptAt: Date | null;
      verifyCount: number;
    }>(
      `SELECT status,
              settled_at AS "settledAt",
              unknown_since AS "unknownSince",
              next_attempt_at AS "nextAttemptAt",
              verify_count AS "verifyCount"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{
      attemptNo: number;
      providerOperationId: string;
      status: string;
    }>(
      `SELECT auto_seq AS "attemptNo",
              provider_operation_id AS "providerOperationId",
              status
       FROM payment_attempts WHERE billing_intent_id = $1
       ORDER BY auto_seq NULLS LAST, started_at`,
      [intentId],
    );
    return rows;
  };

  const makeVerificationDue = (intentId: string) =>
    pool.query(
      `UPDATE billing_intents SET next_verify_at = now() - interval '1 second'
       WHERE id = $1`,
      [intentId],
    );

  const makeRetryDue = (intentId: string) =>
    pool.query(
      `UPDATE billing_intents SET next_attempt_at = now() - interval '1 second'
       WHERE id = $1`,
      [intentId],
    );

  const cleanup = async (): Promise<void> => {
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
    executor = moduleRef.get(ChargeExecutorService);
    sweep = moduleRef.get(ChargeVerificationSweepService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('turns a TIMEOUT into UNKNOWN and retries only after verify FAILED // T57: @E2E-05 @RF-17 @RF-20', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription();
    const intentId = await createScheduledIntent(subscriptionId);

    const first = await executor.execute(intentId);
    expect(first).toMatchObject({ outcome: 'UNKNOWN', attemptNo: 1 });
    expect(gateway.charges).toBe(1);

    let intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.unknownSince).toBeInstanceOf(Date);

    const attempts = await readAttempts(intentId);
    expect(attempts).toHaveLength(1);
    const providerOperationId = attempts[0].providerOperationId;
    gateway.setVerify(providerOperationId, 'FAILED');
    await makeVerificationDue(intentId);
    await sweep.verifyUnknown();

    intent = await readIntent(intentId);
    expect(intent.status).toBe('RETRY_PENDING');
    expect(intent.nextAttemptAt).toBeInstanceOf(Date);
    expect((await readAttempts(intentId)).length).toBe(1);
    expect(gateway.charges).toBe(1);

    await makeRetryDue(intentId);
    const retry = await executor.execute(intentId);
    expect(retry).toMatchObject({
      outcome: 'UNKNOWN',
      billingIntentId: intentId,
      attemptNo: 2,
    });

    const afterRetry = await readAttempts(intentId);
    expect(afterRetry.map((attempt) => attempt.attemptNo)).toEqual([1, 2]);
    expect(gateway.charges).toBe(2);
    expect(gateway.verifications).toBeGreaterThanOrEqual(2);
  });

  it('never re-charges while verification stays UNKNOWN // T57: @E2E-07 @RF-17', async () => {
    gateway.reset();
    const subscriptionId = await createSubscription();
    const intentId = await createScheduledIntent(subscriptionId);

    await executor.execute(intentId);
    expect(gateway.charges).toBe(1);

    const attempts = await readAttempts(intentId);
    gateway.setVerify(attempts[0].providerOperationId, 'UNKNOWN');

    await makeVerificationDue(intentId);
    await sweep.verifyUnknown();
    await makeVerificationDue(intentId);
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(2);
    expect(gateway.charges).toBe(1);
    expect((await readAttempts(intentId)).length).toBe(1);
  });
});

describe('ambiguous charge recovered after a restart (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let sweep: ChargeVerificationSweepService;
  let firstGateway: ScriptedGateway;
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

  const createScheduledIntent = async (subscriptionId: string) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'SCHEDULED')
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
      `SELECT status, settled_at AS "settledAt"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
  };

  const readAttempts = async (intentId: string) => {
    const { rows } = await pool.query<{ providerOperationId: string }>(
      `SELECT provider_operation_id AS "providerOperationId"
       FROM payment_attempts WHERE billing_intent_id = $1`,
      [intentId],
    );
    return rows;
  };

  const makeVerificationDue = (intentId: string) =>
    pool.query(
      `UPDATE billing_intents SET next_verify_at = now() - interval '1 second'
       WHERE id = $1`,
      [intentId],
    );

  afterAll(async () => {
    if (createdSubscriptions.length > 0 && pool) {
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
    await app?.close();
  });

  it('recovers a lost response via verify after the worker restarts // T57: @E2E-06 @RF-15 @RF-16', async () => {
    firstGateway = new ScriptedGateway();
    firstGateway.defaultOutcome = 'AMBIGUOUS';
    moduleRef = await moduleFor(firstGateway).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    const executor = moduleRef.get(ChargeExecutorService);

    const subscriptionId = await createSubscription();
    const intentId = await createScheduledIntent(subscriptionId);

    const first = await executor.execute(intentId);
    expect(first).toMatchObject({ outcome: 'UNKNOWN', attemptNo: 1 });
    expect(firstGateway.charges).toBe(1);
    const attempts = await readAttempts(intentId);
    expect(attempts).toHaveLength(1);
    const providerOperationId = attempts[0].providerOperationId;

    await app.close();

    const restartedGateway = new ScriptedGateway();
    restartedGateway.defaultOutcome = 'AMBIGUOUS';
    restartedGateway.setVerify(providerOperationId, 'SUCCEEDED');
    moduleRef = await moduleFor(restartedGateway).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    sweep = moduleRef.get(ChargeVerificationSweepService);

    await makeVerificationDue(intentId);
    await sweep.verifyUnknown();

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('SUCCEEDED');
    expect(intent.settledAt).toBeInstanceOf(Date);
    expect(restartedGateway.charges).toBe(0);
    expect(firstGateway.charges).toBe(1);
    expect((await readAttempts(intentId)).length).toBe(1);
  });
});
