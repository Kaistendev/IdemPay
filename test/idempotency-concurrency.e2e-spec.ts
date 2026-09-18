import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ChargesService } from '../src/charges/charges.service';
import { REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyRecordKey } from '../src/idempotency/idempotency.constants';
import { IdempotencyStore } from '../src/idempotency/idempotency.store';

const CONCURRENT_REQUESTS = 10;

interface ChargeResponseBody {
  id: string;
  amount: number;
  currency: string;
}

describe('Idempotency concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let store: IdempotencyStore;
  let charges: ChargesService;
  let redis: Redis;
  const runId = `t7-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];
  let counter = 0;

  const nextKey = (): string => {
    counter += 1;
    const key = `${runId}-${counter}`;
    createdKeys.push(idempotencyRecordKey(key));
    return key;
  };

  const postCharge = (key: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/charges')
      .set('Idempotency-Key', key)
      .send(body);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    store = moduleRef.get(IdempotencyStore);
    charges = moduleRef.get(ChargesService);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await app.close();
  });

  it('produces a single operation for N concurrent requests with the same key and payload', async () => {
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
    }

    const record = await store.read(key);
    expect(record?.state).toBe('SETTLED');
    expect(record?.billingIntentRef).toBe(settled.id);
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
    const record = await store.read(key);
    expect(record?.state).toBe('SETTLED');
    expect(record?.billingIntentRef).toBe(settled.id);
  });
});
