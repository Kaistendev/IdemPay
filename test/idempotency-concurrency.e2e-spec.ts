import { Injectable, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { ChargeRequest } from '../src/charges/charge.schema';
import { ChargesService } from '../src/charges/charges.service';
import type { ChargeResult } from '../src/charges/charges.types';
import { PG_POOL } from '../src/health/health.constants';
import { IdempotencyUnitOfWork } from '../src/idempotency/idempotency.uow';

const CONCURRENT_REQUESTS = 10;
const CHARGE_ANCHOR = '2070-01-01';
const createdSubscriptionIds: string[] = [];

@Injectable()
class PersistedChargesService {
  private executions = 0;

  constructor(private readonly uow: IdempotencyUnitOfWork) {}

  async create(request: ChargeRequest): Promise<ChargeResult> {
    this.executions += 1;
    const client = this.uow.current();
    if (!client) {
      throw new Error('No transaction is active for the request');
    }
    const id = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone)
       VALUES ($1, $2, 'monthly', $3, 'UTC')
       RETURNING id`,
      [request.amount, request.currency, CHARGE_ANCHOR],
    );
    createdSubscriptionIds.push(rows[0].id);
    await client.query(
      `INSERT INTO billing_intents
         (id, subscription_id, billing_cycle, schedule_date, amount, currency)
       VALUES ($1, $2, '2026-01-01', '2026-01-01', $3, $4)`,
      [id, rows[0].id, request.amount, request.currency],
    );
    return {
      id,
      status: 'CREATED',
      amount: request.amount,
      currency: request.currency,
    };
  }

  executionCount(): number {
    return this.executions;
  }
}

interface ChargeResponseBody {
  id: string;
  amount: number;
  currency: string;
}

interface OperationRow {
  status: 'PROCESSING' | 'SETTLED';
  billing_intent_id: string | null;
}

describe('Idempotency concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let charges: PersistedChargesService;
  const runId = `t7-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];
  let counter = 0;

  const nextKey = (): string => {
    counter += 1;
    const key = `${runId}-${counter}`;
    createdKeys.push(key);
    return key;
  };

  const postCharge = (key: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/charges')
      .set('Idempotency-Key', key)
      .send(body);

  const readRow = async (key: string): Promise<OperationRow | null> => {
    const { rows } = await pool.query<OperationRow>(
      `SELECT status, billing_intent_id
       FROM idempotency_operations
       WHERE key = $1
       ORDER BY generation DESC
       LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ChargesService)
      .useClass(PersistedChargesService)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    charges = moduleRef.get(ChargesService);
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await pool.query(
        'DELETE FROM idempotency_operations WHERE key = ANY($1)',
        [createdKeys],
      );
    }
    if (createdSubscriptionIds.length > 0) {
      await pool.query(
        'DELETE FROM billing_intents WHERE subscription_id = ANY($1::uuid[])',
        [createdSubscriptionIds],
      );
      await pool.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [
        createdSubscriptionIds,
      ]);
    }
    await app.close();
  });

  it('produces a single operation for N concurrent requests with the same key and payload // T61: @INV-05 @INV-06', async () => {
    const key = nextKey();
    const body = { amount: 100, currency: 'USD' };
    const before = charges.executionCount();

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => postCharge(key, body)),
    );

    expect(charges.executionCount() - before).toBe(1);

    for (const response of responses) {
      expect([201, 423]).toContain(response.status);
    }

    const accepted = responses.filter((response) => response.status === 201);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    const settled = accepted[0].body as ChargeResponseBody;
    for (const response of accepted) {
      expect(response.body).toEqual(settled);
    }

    for (const response of responses.filter((r) => r.status === 423)) {
      expect(response.body).toMatchObject({ error: 'IDEMPOTENCY_LOCKED' });
      expect(response.headers['retry-after']).toMatch(/^\d+$/);
    }

    const record = await readRow(key);
    expect(record?.status).toBe('SETTLED');
    expect(record?.billing_intent_id).toBe(settled.id);
  });

  it('accepts exactly one operation and returns 409 for concurrent different payloads', async () => {
    const key = nextKey();
    const before = charges.executionCount();

    const responses = await Promise.all([
      postCharge(key, { amount: 100, currency: 'USD' }),
      postCharge(key, { amount: 200, currency: 'USD' }),
    ]);

    const statuses = responses
      .map((response) => response.status)
      .sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const rejected = responses.find((response) => response.status === 409);
    expect(rejected?.body).toMatchObject({
      error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });

    expect(charges.executionCount() - before).toBe(1);

    const accepted = responses.find((response) => response.status === 201);
    const settled = accepted?.body as ChargeResponseBody;
    const record = await readRow(key);
    expect(record?.status).toBe('SETTLED');
    expect(record?.billing_intent_id).toBe(settled.id);
  });
});
