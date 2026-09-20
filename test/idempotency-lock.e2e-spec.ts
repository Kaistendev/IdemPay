import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../src/health/health.constants';
import {
  IDEMPOTENCY_LOCK_MS,
  IDEMPOTENCY_TTL_MS,
  idempotencyLockKey,
} from '../src/idempotency/idempotency.constants';
import { IdempotencyKeyLock } from '../src/idempotency/idempotency.lock';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('IdempotencyKeyLock (real Redis)', () => {
  let moduleRef: TestingModule;
  let lock: IdempotencyKeyLock;
  let redis: Redis;
  const runId = `t26-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];

  const nextKey = (): string => {
    const key = `${runId}-${createdKeys.length + 1}`;
    createdKeys.push(idempotencyLockKey(key));
    return key;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [IdempotencyModule],
    }).compile();
    lock = moduleRef.get(IdempotencyKeyLock);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await moduleRef.close();
  });

  it('acquires the lock with SET NX exactly once per key', async () => {
    const key = nextKey();

    await expect(lock.acquire(key)).resolves.toBe(true);
    await expect(lock.acquire(key)).resolves.toBe(false);
  });

  it('holds a short TTL instead of the 24 hour record TTL', async () => {
    const key = nextKey();

    await lock.acquire(key);
    const ttl = await redis.pttl(idempotencyLockKey(key));

    expect(IDEMPOTENCY_LOCK_MS).toBeLessThan(IDEMPOTENCY_TTL_MS);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_LOCK_MS);
  });

  it('re-acquires once the lock expires', async () => {
    const key = nextKey();
    await expect(lock.acquire(key)).resolves.toBe(true);

    await redis.pexpire(idempotencyLockKey(key), 20);
    await wait(60);

    await expect(lock.acquire(key)).resolves.toBe(true);
  });

  it('never writes a decision record under the plain idem: prefix', async () => {
    const key = nextKey();
    await lock.acquire(key);

    const keyspace = await redis.keys(`idem:*${runId}*`);

    expect(keyspace.length).toBeGreaterThan(0);
    expect(keyspace.every((k) => k.startsWith('idem:lock:'))).toBe(true);
  });

  it('fails open when Redis is unreachable', async () => {
    const brokenRedis = {
      set: () => {
        throw new Error('Redis is down');
      },
      disconnect: () => undefined,
    } as unknown as Redis;

    const brokenModule = await Test.createTestingModule({
      imports: [IdempotencyModule],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue(brokenRedis)
      .compile();

    const downLock = brokenModule.get(IdempotencyKeyLock);

    await expect(downLock.acquire(`down-${runId}`)).resolves.toBe(true);
    await brokenModule.close();
  });
});
