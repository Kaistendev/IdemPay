import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { BillingCycleChargeResponse } from '../src/billing-cycles/billing-cycle.types';
import { PAYMENT_GATEWAY } from '../src/gateway/gateway.constants';
import type {
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../src/gateway/gateway.types';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyLockKey } from '../src/idempotency/idempotency.constants';

const CONCURRENT_REQUESTS = 10;
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class ScriptedGateway implements IPaymentGateway {
  chargesCalled = 0;
  verifyCalled = 0;
  outcome: ChargeOutcome = 'SUCCEEDED';
  deferred = false;

  private resolvePending: ((result: ChargeResult) => void) | null = null;
  private pendingProviderOperationId = '';
  private chargeStartedResolver: (() => void) | null = null;

  waitForCharge(): Promise<void> {
    return new Promise((resolve) => {
      this.chargeStartedResolver = resolve;
    });
  }

  complete(): void {
    this.resolvePending?.({
      providerOperationId: this.pendingProviderOperationId,
      outcome: this.outcome,
    });
    this.resolvePending = null;
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.chargesCalled += 1;
    this.pendingProviderOperationId = request.providerOperationId;
    this.chargeStartedResolver?.();
    return new Promise<ChargeResult>((resolve) => {
      if (this.deferred) {
        this.resolvePending = resolve;
      } else {
        resolve({
          providerOperationId: request.providerOperationId,
          outcome: this.outcome,
        });
      }
    });
  }

  verify(): Promise<VerificationResult> {
    this.verifyCalled += 1;
    return Promise.resolve(
      this.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
    );
  }
}

interface OperationRow {
  status: 'PROCESSING' | 'SETTLED';
  billingIntentId: string | null;
}

describe('idempotency and concurrency on the billing cycle charge endpoint (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  let gateway: ScriptedGateway;
  const runId = `t56-${process.pid}-${Date.now()}`;
  const createdSubscriptions: string[] = [];
  const createdKeys: string[] = [];
  const createdOperationKeys: string[] = [];
  let keyCounter = 0;
  let cycleCounter = 0;

  const nextKey = (): string => {
    keyCounter += 1;
    const key = `${runId}-${keyCounter}`;
    createdKeys.push(idempotencyLockKey(key));
    createdOperationKeys.push(key);
    return key;
  };

  const nextCycle = (): string => {
    cycleCounter += 1;
    const date = new Date(Date.UTC(2026, 0, 2 + cycleCounter * 14));
    return date.toISOString().slice(0, 10);
  };

  const createSubscription = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone)
       VALUES (100, 'USD', 'monthly', '2026-01-10', 'UTC')
       RETURNING id`,
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const charge = (
    subscriptionId: string,
    cycle: string,
    key: string,
    body?: Record<string, unknown>,
  ): request.Test =>
    request(app.getHttpServer())
      .post(`/subscriptions/${subscriptionId}/billing-cycles/${cycle}/charge`)
      .set('Idempotency-Key', key)
      .send(body ?? {});

  const intentCount = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM billing_intents WHERE subscription_id = $1`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const attemptCount = async (subscriptionId: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM payment_attempts
       WHERE billing_intent_id IN (
         SELECT id FROM billing_intents WHERE subscription_id = $1
       )`,
      [subscriptionId],
    );
    return rows[0].count;
  };

  const latestOperation = async (key: string): Promise<OperationRow | null> => {
    const { rows } = await pool.query<OperationRow>(
      `SELECT status, billing_intent_id AS "billingIntentId"
       FROM idempotency_operations WHERE key = $1
       ORDER BY generation DESC LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  };

  const waitFor = async (
    predicate: () => Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await wait(25);
    }
    throw new Error('Timed out waiting for condition');
  };

  beforeAll(async () => {
    gateway = new ScriptedGateway();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdOperationKeys.length > 0) {
      await pool.query(
        'DELETE FROM idempotency_operations WHERE key = ANY($1)',
        [createdOperationKeys],
      );
    }
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
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await app.close();
  });

  it('converges concurrent same-key requests to a single settled charge // T56: @E2E-01 @RF-01 @RF-02 @RF-06', async () => {
    gateway.deferred = false;
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();
    const before = gateway.chargesCalled;

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        charge(subscriptionId, cycle, key),
      ),
    );

    expect(gateway.chargesCalled - before).toBe(1);
    for (const response of responses) {
      expect([200, 423]).toContain(response.status);
    }

    const accepted = responses.filter((response) => response.status === 200);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const settled = accepted[0].body as BillingCycleChargeResponse;
    for (const response of accepted) {
      expect(response.body).toEqual(settled);
    }

    for (const response of responses.filter((r) => r.status === 423)) {
      expect(response.body).toMatchObject({ error: 'IDEMPOTENCY_LOCKED' });
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
    }

    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);

    const operation = await latestOperation(key);
    expect(operation?.status).toBe('SETTLED');
    expect(operation?.billingIntentId).toBe(settled.id);
  });

  it('accepts one request and rejects concurrent different payloads with 409 // T56: @E2E-02 @RF-03 @RF-07', async () => {
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();
    const before = gateway.chargesCalled;

    const responses = await Promise.all([
      charge(subscriptionId, cycle, key, { amount: 100 }),
      charge(subscriptionId, cycle, key, { amount: 200 }),
    ]);

    const statuses = responses
      .map((response) => response.status)
      .sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const rejected = responses.find((response) => response.status === 409);
    expect(rejected?.body).toMatchObject({
      error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });

    expect(gateway.chargesCalled - before).toBe(1);
    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);

    const accepted = responses.find((response) => response.status === 200);
    const operation = await latestOperation(key);
    expect(operation?.status).toBe('SETTLED');
    expect(operation?.billingIntentId).toBe(
      (accepted?.body as BillingCycleChargeResponse).id,
    );
  });

  it('locks a key while the operation is in flight and never double-charges // T56: @E2E-04 @RF-05', async () => {
    gateway.deferred = true;
    const subscriptionId = await createSubscription();
    const cycle = nextCycle();
    const key = nextKey();
    const before = gateway.chargesCalled;

    const first = charge(subscriptionId, cycle, key).then(
      (response) => response,
    );
    await gateway.waitForCharge();
    await waitFor(
      async () => (await latestOperation(key))?.status === 'PROCESSING',
    );

    const second = await charge(subscriptionId, cycle, key);
    expect(second.status).toBe(423);
    expect(second.body).toMatchObject({ error: 'IDEMPOTENCY_LOCKED' });
    expect(second.headers['retry-after']).toMatch(/^\d+$/);

    gateway.complete();
    const settled = await first;
    expect(settled.status).toBe(200);
    expect((settled.body as BillingCycleChargeResponse).status).toBe(
      'SUCCEEDED',
    );

    expect(gateway.chargesCalled - before).toBe(1);
    expect(await intentCount(subscriptionId)).toBe(1);
    expect(await attemptCount(subscriptionId)).toBe(1);

    const operation = await latestOperation(key);
    expect(operation?.status).toBe('SETTLED');
    gateway.deferred = false;
  });
});
