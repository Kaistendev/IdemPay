import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { VERIFICATION_SWEEP_INTERVAL } from '../src/charge-executor/charge-verification.interval';
import { ChargeVerificationSweepService } from '../src/charge-executor/charge-verification.sweep.service';
import { PAYMENT_GATEWAY } from '../src/gateway/gateway.constants';
import type {
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../src/gateway/gateway.types';
import { PG_POOL } from '../src/health/health.constants';

class ScriptedGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome: 'SUCCEEDED',
    });
  }

  verify(): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve('UNKNOWN');
  }
}

describe('UNKNOWN verification cadence (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let pool: Pool;
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

  const createUnknownIntent = async (
    subscriptionId: string,
    providerOperationId: string,
    ageHours = 0,
  ): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status,
          unknown_since)
       VALUES ($1, '2026-05-10', '2026-05-10', 100, 'USD', 'UNKNOWN',
               now() - ($2 * interval '1 hour'))
       RETURNING id`,
      [subscriptionId, ageHours],
    );
    const intentId = rows[0].id;
    await pool.query(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status, started_at, finished_at)
       VALUES ($1, 'AUTO', 1, $2, 'UNKNOWN', now() - interval '1 minute', now())`,
      [intentId, providerOperationId],
    );
    return intentId;
  };

  const readIntent = async (intentId: string) => {
    const { rows } = await pool.query<{
      status: string;
      nextVerifyAt: Date | null;
      verifyCount: number;
      needsManualReview: boolean;
    }>(
      `SELECT status,
              next_verify_at AS "nextVerifyAt",
              verify_count AS "verifyCount",
              needs_manual_review AS "needsManualReview"
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0];
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
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(VERIFICATION_SWEEP_INTERVAL)
      .useValue(60_000)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    sweep = moduleRef.get(ChargeVerificationSweepService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('schedules the next verification and does not re-verify before it is due', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createUnknownIntent(subscriptionId, 'op-cad-1');

    const processed = await sweep.verifyUnknown();
    expect(processed).toBe(1);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(1);
    expect(intent.needsManualReview).toBe(false);
    expect(intent.nextVerifyAt).toBeInstanceOf(Date);
    const firstWindow = intent.nextVerifyAt!.getTime() - Date.now();
    expect(firstWindow).toBeGreaterThanOrEqual(0.8 * 60_000);
    expect(firstWindow).toBeLessThanOrEqual(1.2 * 60_000 + 500);

    const skipped = await sweep.verifyUnknown();
    expect(skipped).toBe(0);

    const unchanged = await readIntent(intentId);
    expect(unchanged.verifyCount).toBe(1);
    expect(gateway.charges).toBe(0);
  });

  it('re-verifies on cadence once next_verify_at passes and grows the window', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createUnknownIntent(subscriptionId, 'op-cad-2');

    await sweep.verifyUnknown();
    await makeVerificationDue(intentId);

    const reprocessed = await sweep.verifyUnknown();
    expect(reprocessed).toBe(1);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(2);
    const secondWindow = intent.nextVerifyAt!.getTime() - Date.now();
    expect(secondWindow).toBeGreaterThanOrEqual(0.8 * 120_000);
    expect(secondWindow).toBeLessThanOrEqual(1.2 * 120_000 + 500);
    expect(gateway.charges).toBe(0);
  });

  it('marks needs_manual_review on the tenth verification without changing state', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createUnknownIntent(subscriptionId, 'op-cad-3');

    for (let count = 1; count <= 10; count += 1) {
      await makeVerificationDue(intentId);
      const processed = await sweep.verifyUnknown();
      expect(processed).toBe(1);
    }

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(10);
    expect(intent.needsManualReview).toBe(true);
    expect(intent.nextVerifyAt).toBeNull();

    await makeVerificationDue(intentId);
    const afterReview = await sweep.verifyUnknown();
    expect(afterReview).toBe(0);

    const still = await readIntent(intentId);
    expect(still.verifyCount).toBe(10);
    expect(gateway.charges).toBe(0);
  });

  it('marks needs_manual_review from the age of the unknown state without a new verification', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createUnknownIntent(subscriptionId, 'op-cad-4', 25);

    const verificationsBefore = gateway.verifications;
    const processed = await sweep.verifyUnknown();

    expect(processed).toBe(1);
    expect(gateway.verifications).toBe(verificationsBefore);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('UNKNOWN');
    expect(intent.verifyCount).toBe(0);
    expect(intent.needsManualReview).toBe(true);
    expect(intent.nextVerifyAt).toBeNull();
    expect(gateway.charges).toBe(0);
  });
});
