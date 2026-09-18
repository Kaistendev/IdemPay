import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../src/health/health.constants';
import {
  IDEMPOTENCY_TTL_MS,
  idempotencyRecordKey,
} from '../src/idempotency/idempotency.constants';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { IdempotencyStore } from '../src/idempotency/idempotency.store';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('IdempotencyStore (real Redis)', () => {
  let moduleRef: TestingModule;
  let store: IdempotencyStore;
  let redis: Redis;
  const runId = `t5-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];

  const nextKey = (): string => {
    const key = `${runId}-${createdKeys.length + 1}`;
    createdKeys.push(idempotencyRecordKey(key));
    return key;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule],
    }).compile();
    store = moduleRef.get(IdempotencyStore);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await moduleRef.close();
  });

  it('registers a PROCESSING record with the canonical hash', async () => {
    const key = nextKey();

    const result = await store.begin(key, 'hash-a');

    expect(result.acquired).toBe(true);
    expect(result.record).toMatchObject({
      key,
      payloadHash: 'hash-a',
      state: 'PROCESSING',
      response: null,
      billingIntentRef: null,
    });
    expect(typeof result.record.createdAt).toBe('string');

    const stored = await store.read(key);
    expect(stored).toEqual(result.record);
  });

  it('does not overwrite an existing key and returns the original record', async () => {
    const key = nextKey();
    await store.begin(key, 'hash-a');

    const second = await store.begin(key, 'hash-b');

    expect(second.acquired).toBe(false);
    expect(second.record.payloadHash).toBe('hash-a');

    const stored = await store.read(key);
    expect(stored?.payloadHash).toBe('hash-a');
  });

  it('sets a 24 hour TTL with no grace period', async () => {
    const key = nextKey();

    await store.begin(key, 'hash-a');
    const ttl = await store.ttlMillis(key);

    expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
    expect(ttl).toBeGreaterThan(IDEMPOTENCY_TTL_MS - 10_000);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS);
  });

  it('settles the record preserving state, response and remaining TTL', async () => {
    const key = nextKey();
    await store.begin(key, 'hash-a');
    await wait(120);
    const before = await store.ttlMillis(key);

    const settled = await store.settle(key, {
      response: { statusCode: 201, body: { id: 'bi-1' } },
      billingIntentRef: 'bi-1',
    });

    expect(settled).toMatchObject({
      state: 'SETTLED',
      billingIntentRef: 'bi-1',
      response: { statusCode: 201, body: { id: 'bi-1' } },
    });
    expect(settled?.settledAt).toEqual(expect.any(String));

    const after = await store.ttlMillis(key);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);

    const stored = await store.read(key);
    expect(stored).toEqual(settled);
  });

  it('returns null when settling an unknown or already settled key', async () => {
    const missing = nextKey();
    expect(
      await store.settle(missing, {
        response: { statusCode: 200, body: null },
        billingIntentRef: 'bi-x',
      }),
    ).toBeNull();

    const key = nextKey();
    await store.begin(key, 'hash-a');
    await store.settle(key, {
      response: { statusCode: 200, body: { ok: true } },
      billingIntentRef: 'bi-1',
    });

    expect(
      await store.settle(key, {
        response: { statusCode: 500, body: null },
        billingIntentRef: 'bi-2',
      }),
    ).toBeNull();

    const stored = await store.read(key);
    expect(stored?.response).toEqual({ statusCode: 200, body: { ok: true } });
  });

  it('allows re-registration after the key expires', async () => {
    const key = nextKey();
    const first = await store.begin(key, 'hash-a');
    expect(first.acquired).toBe(true);

    await redis.pexpire(idempotencyRecordKey(key), 20);
    await wait(60);

    const second = await store.begin(key, 'hash-b');

    expect(second.acquired).toBe(true);
    expect(second.record.payloadHash).toBe('hash-b');
  });
});
