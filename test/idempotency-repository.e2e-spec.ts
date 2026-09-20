import { Client, Pool } from 'pg';
import type { Clock } from '../src/common/time/clock';
import { MigrationRunner } from '../src/database/migration-runner';
import { IdempotencyRepository } from '../src/idempotency/idempotency.repository';
import type { IdempotencyRegistration } from '../src/idempotency/idempotency.types';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

class MutableClock implements Clock {
  private value: Date;

  constructor(iso: string) {
    this.value = new Date(iso);
  }

  now(): Date {
    return new Date(this.value);
  }

  set(iso: string): void {
    this.value = new Date(iso);
  }

  advance(millis: number): void {
    this.value = new Date(this.value.getTime() + millis);
  }
}

type InFlight = Extract<IdempotencyRegistration, { outcome: 'IN_FLIGHT' }>;
type Replay = Extract<IdempotencyRegistration, { outcome: 'REPLAY' }>;
type Mismatch = Extract<IdempotencyRegistration, { outcome: 'MISMATCH' }>;
type Retake = Extract<IdempotencyRegistration, { outcome: 'RETAKE' }>;

describe('idempotency repository (e2e)', () => {
  const schema = `t24_${process.pid}_${Date.now()}`;
  const T0 = '2026-01-01T00:00:00Z';
  let admin: Client;
  let pool: Pool;
  let clock: MutableClock;
  let repository: IdempotencyRepository;
  let keySeq = 0;

  const nextKey = (): string => {
    keySeq += 1;
    return `key-${keySeq}`;
  };

  const register = (key: string, payloadHash = 'hash-a') =>
    repository.registerOrGet(key, payloadHash, 'SUBSCRIPTION_CREATE');

  const settle = async (
    key: string,
    generation: number,
    responseStatus: number,
    responseBody: unknown,
  ): Promise<void> => {
    await pool.query(
      `UPDATE idempotency_operations
         SET status = 'SETTLED', response_status = $3, response_body = $4,
             settled_at = $5, lease_expires_at = NULL
       WHERE key = $1 AND generation = $2`,
      [key, generation, responseStatus, responseBody, '2026-01-01T00:01:00Z'],
    );
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: CONNECTION_STRING });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      options: `-c search_path=${schema}`,
    });

    const runner = new MigrationRunner(pool);
    await runner.run();

    clock = new MutableClock(T0);
    repository = new IdempotencyRepository(pool, clock);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('registers the first use of a key as NEW (generation 1)', async () => {
    const key = nextKey();

    await expect(register(key)).resolves.toEqual({
      outcome: 'NEW',
      generation: 1,
    });
  });

  it('returns IN_FLIGHT for the same key and payload while PROCESSING', async () => {
    const key = nextKey();
    await register(key);

    const second = (await register(key)) as InFlight;
    expect(second.outcome).toBe('IN_FLIGHT');
    expect(second.leaseRemainingSeconds).toBeGreaterThan(0);
  });

  it('replays the settled response for the same key and payload (RF-02)', async () => {
    const key = nextKey();
    await register(key);
    await settle(key, 1, 201, { status: 'created', id: 'intent-1' });

    const replay = (await register(key)) as Replay;
    expect(replay.outcome).toBe('REPLAY');
    expect(replay.response).toEqual({
      statusCode: 201,
      body: { status: 'created', id: 'intent-1' },
    });
    expect(replay.billingIntentId).toBeNull();
  });

  it('returns MISMATCH for a different payload even while PROCESSING (RF-03, D14)', async () => {
    const key = nextKey();
    await register(key, 'hash-a');

    const mismatch = (await register(key, 'hash-b')) as Mismatch;
    expect(mismatch.outcome).toBe('MISMATCH');
    expect(mismatch.storedPayloadHash).toBe('hash-a');

    const conflicting = (await register(key, 'hash-c')) as Mismatch;
    expect(conflicting.outcome).toBe('MISMATCH');
  });

  it('starts a new generation once the 24h window expires (RF-04)', async () => {
    const key = nextKey();
    clock.set(T0);
    await register(key, 'hash-a');

    clock.advance(25 * HOUR);
    await expect(register(key, 'hash-b')).resolves.toEqual({
      outcome: 'NEW',
      generation: 2,
    });

    const second = (await register(key, 'hash-b')) as InFlight;
    expect(second.outcome).toBe('IN_FLIGHT');
  });

  it('takes over a PROCESSING operation whose lease expired (RETAKE, D3)', async () => {
    const key = nextKey();
    clock.set(T0);
    await register(key, 'hash-a');

    clock.advance(6 * MINUTE);
    const retake = (await register(key, 'hash-a')) as Retake;
    expect(retake.outcome).toBe('RETAKE');
    expect(retake.generation).toBe(1);

    const after = (await register(key, 'hash-a')) as InFlight;
    expect(after.outcome).toBe('IN_FLIGHT');
  });

  it('grants an expired lease to exactly one concurrent caller', async () => {
    const key = nextKey();
    clock.set(T0);
    await register(key, 'hash-a');
    clock.advance(6 * MINUTE);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => register(key, 'hash-a')),
    );

    expect(results.filter((r) => r.outcome === 'RETAKE')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IN_FLIGHT')).toHaveLength(9);
  });

  it('grants exactly one NEW among 50 concurrent same-key calls (RF-06)', async () => {
    const key = nextKey();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => register(key, 'hash-a')),
    );

    const outcomes = results.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'NEW')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'IN_FLIGHT')).toHaveLength(49);
  });
});
