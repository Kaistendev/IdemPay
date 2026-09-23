import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyLockKey } from '../src/idempotency/idempotency.constants';

interface SubscriptionResponse {
  id: string;
  amount: number;
  currency: string;
  frequency: string;
  startDate: string;
  timezone: string;
  status: string;
  createdAt: string;
}

interface CreateBody {
  amount: number;
  currency: string;
  frequency: string;
  startDate: string;
  timezone: string;
}

const isoDaysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

describe('subscriptions create (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let redis: Redis;
  const runId = `t9-${process.pid}-${Date.now()}`;
  const createdIds: string[] = [];
  const createdKeys: string[] = [];
  let counter = 0;

  const nextKey = (): string => {
    counter += 1;
    const key = `${runId}-${counter}`;
    createdKeys.push(idempotencyLockKey(key));
    return key;
  };

  const validBody = (): CreateBody => ({
    amount: 1500,
    currency: 'USD',
    frequency: 'monthly',
    startDate: isoDaysFromToday(1),
    timezone: 'America/Argentina/Buenos_Aires',
  });

  const post = (key: string, body: CreateBody) =>
    request(app.getHttpServer())
      .post('/subscriptions')
      .set('Idempotency-Key', key)
      .send(body);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query('DELETE FROM subscriptions WHERE id = ANY($1::uuid[])', [
        createdIds,
      ]);
    }
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await app.close();
  });

  it('creates an ACTIVE subscription and persists it // T61: @RF-08', async () => {
    const body = validBody();
    const response = await post(nextKey(), body);

    expect(response.status).toBe(201);
    const created = response.body as SubscriptionResponse;
    createdIds.push(created.id);

    expect(created).toMatchObject({
      amount: body.amount,
      currency: body.currency,
      frequency: body.frequency,
      startDate: body.startDate,
      timezone: body.timezone,
      status: 'ACTIVE',
    });
    expect(typeof created.id).toBe('string');
    expect(new Date(created.createdAt).toString()).not.toBe('Invalid Date');

    const persisted = await pool.query<{ status: string; amount: string }>(
      'SELECT status, amount FROM subscriptions WHERE id = $1',
      [created.id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ status: 'ACTIVE' });
    expect(Number(persisted.rows[0].amount)).toBe(body.amount);
  });

  it('replays the settled response for a repeated idempotency key', async () => {
    const body = validBody();
    const key = nextKey();

    const first = await post(key, body);
    const second = await post(key, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const firstId = (first.body as SubscriptionResponse).id;
    createdIds.push(firstId);

    const persisted = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM subscriptions WHERE id = $1',
      [firstId],
    );
    expect(persisted.rows[0].count).toBe(1);
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const response = await request(app.getHttpServer())
      .post('/subscriptions')
      .send(validBody());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it('rejects a decimal amount with 400', async () => {
    const response = await post(nextKey(), { ...validBody(), amount: 15.5 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"amount"');
  });

  it('rejects a non-ISO 4217 currency with 400', async () => {
    const response = await post(nextKey(), { ...validBody(), currency: 'ZZZ' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"currency"');
  });

  it('rejects a non-positive amount with 400', async () => {
    const response = await post(nextKey(), { ...validBody(), amount: 0 });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"amount"');
  });

  it('rejects a malformed currency with 400', async () => {
    const response = await post(nextKey(), { ...validBody(), currency: 'usd' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"currency"');
  });

  it('rejects an unknown frequency with 400 // T61: @RF-08', async () => {
    const response = await post(nextKey(), {
      ...validBody(),
      frequency: 'hourly',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"frequency"');
  });

  it('rejects an invalid time zone with 400', async () => {
    const response = await post(nextKey(), {
      ...validBody(),
      timezone: 'Not/AZone',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"timezone"');
  });

  it('rejects an invalid calendar date with 400', async () => {
    const response = await post(nextKey(), {
      ...validBody(),
      startDate: '2026-02-30',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"startDate"');
  });

  it('rejects a startDate in the past with 400', async () => {
    const response = await post(nextKey(), {
      ...validBody(),
      startDate: '2000-01-01',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"startDate"');
    expect(response.text).toContain('"code":"not_allowed"');
  });
});
