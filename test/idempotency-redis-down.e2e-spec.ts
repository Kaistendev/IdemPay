import {
  Body,
  Controller,
  INestApplication,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { CommonModule } from '../src/common/common.module';
import { hashCanonicalPayload } from '../src/common/idempotency/payload-hash';
import { ZodValidationPipe } from '../src/common/validation/zod-validation.pipe';
import { PG_POOL, REDIS_CLIENT } from '../src/health/health.constants';
import { IdempotencyContext } from '../src/idempotency/idempotency.context';
import type { IdempotencyOperationContext } from '../src/idempotency/idempotency.context';
import { IdempotencyGuard } from '../src/idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../src/idempotency/idempotency.interceptor';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { IdempotencyRepository } from '../src/idempotency/idempotency.repository';
import { IdempotencyUnitOfWork } from '../src/idempotency/idempotency.uow';

const chargeSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

type ChargeBody = z.infer<typeof chargeSchema>;

const FAKE_ANCHOR = '2081-01-01';
const CRASH_ANCHOR = '2098-01-01';

const INSERT_SUBSCRIPTION = `
INSERT INTO subscriptions
  (amount, currency, frequency, anchor_date, timezone)
VALUES ($1, $2, 'monthly', $3, 'UTC')
RETURNING id
`;

const INSERT_BILLING_INTENT = `
INSERT INTO billing_intents
  (id, subscription_id, billing_cycle, schedule_date, amount, currency)
VALUES ($1, $2, '2026-01-01', '2026-01-01', $3, $4)
`;

const brokenRedis = {
  set: () => {
    throw new Error('Redis is down');
  },
  disconnect: () => undefined,
} as unknown as Redis;

@Controller('idempotency-redisdown')
class IdempotencyRedisDownController {
  static executions = 0;

  constructor(private readonly uow: IdempotencyUnitOfWork) {}

  @Post()
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  async create(
    @Body(new ZodValidationPipe(chargeSchema)) body: ChargeBody,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): Promise<ChargeBody & { id: string }> {
    IdempotencyRedisDownController.executions += 1;
    const client = this.uow.current();
    if (!client) {
      throw new Error('No transaction is active for the request');
    }
    const id = randomUUID();
    const { rows } = await client.query<{ id: string }>(INSERT_SUBSCRIPTION, [
      body.amount,
      body.currency,
      FAKE_ANCHOR,
    ]);
    await client.query(INSERT_BILLING_INTENT, [
      id,
      rows[0].id,
      body.amount,
      body.currency,
    ]);
    context.billingIntentRef = id;
    return { id, ...body };
  }
}

@Controller('idempotency-redisdown-crash')
class IdempotencyRedisDownCrashController {
  static executions = 0;

  constructor(private readonly uow: IdempotencyUnitOfWork) {}

  @Post()
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  async crash(
    @Body(new ZodValidationPipe(chargeSchema)) body: ChargeBody,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): Promise<ChargeBody & { id: string }> {
    IdempotencyRedisDownCrashController.executions += 1;
    const client = this.uow.current();
    if (!client) {
      throw new Error('No transaction is active for the request');
    }
    const id = randomUUID();
    const { rows } = await client.query<{ id: string }>(INSERT_SUBSCRIPTION, [
      body.amount,
      body.currency,
      CRASH_ANCHOR,
    ]);
    await client.query(INSERT_BILLING_INTENT, [
      id,
      rows[0].id,
      body.amount,
      body.currency,
    ]);
    context.billingIntentRef = id;
    if (IdempotencyRedisDownCrashController.executions === 1) {
      throw new Error('Simulated crash after the business effect');
    }
    return { id, ...body };
  }
}

interface OperationRow {
  status: 'PROCESSING' | 'SETTLED';
  response_status: number | null;
  billing_intent_id: string | null;
  settled_at: Date | null;
}

describe('Idempotency with Redis unavailable (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let repository: IdempotencyRepository;
  const runId = `t26-redisdown-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];
  let counter = 0;

  const nextKey = (): string => {
    counter += 1;
    const key = `${runId}-${counter}`;
    createdKeys.push(key);
    return key;
  };

  const post = (key: string | undefined, body: Record<string, unknown>) => {
    const agent = request(app.getHttpServer())
      .post('/idempotency-redisdown')
      .send(body);
    return key === undefined ? agent : agent.set('Idempotency-Key', key);
  };

  const postCrash = (key: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/idempotency-redisdown-crash')
      .set('Idempotency-Key', key)
      .send(body);

  const readRow = async (key: string): Promise<OperationRow | null> => {
    const { rows } = await pool.query<OperationRow>(
      `SELECT status, response_status, billing_intent_id, settled_at
       FROM idempotency_operations
       WHERE key = $1
       ORDER BY generation DESC
       LIMIT 1`,
      [key],
    );
    return rows[0] ?? null;
  };

  const expireLease = async (key: string): Promise<void> => {
    await pool.query(
      `UPDATE idempotency_operations
       SET lease_expires_at = now() - interval '1 second'
       WHERE key = $1`,
      [key],
    );
  };

  const subscriptionCount = async (anchor: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM subscriptions WHERE anchor_date = $1',
      [anchor],
    );
    return rows[0].count;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonModule, IdempotencyModule],
      controllers: [
        IdempotencyRedisDownController,
        IdempotencyRedisDownCrashController,
      ],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue(brokenRedis)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = moduleRef.get<Pool>(PG_POOL);
    repository = moduleRef.get(IdempotencyRepository);
  });

  beforeEach(() => {
    IdempotencyRedisDownController.executions = 0;
    IdempotencyRedisDownCrashController.executions = 0;
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await pool.query(
        'DELETE FROM idempotency_operations WHERE key = ANY($1)',
        [createdKeys],
      );
    }
    await pool.query(
      `DELETE FROM billing_intents
       WHERE subscription_id IN (
         SELECT id FROM subscriptions WHERE anchor_date IN ($1, $2)
       )`,
      [FAKE_ANCHOR, CRASH_ANCHOR],
    );
    await pool.query(
      'DELETE FROM subscriptions WHERE anchor_date IN ($1, $2)',
      [FAKE_ANCHOR, CRASH_ANCHOR],
    );
    await app.close();
  });

  it('rejects a keyless request with 400', async () => {
    const response = await post(undefined, { amount: 100, currency: 'USD' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(IdempotencyRedisDownController.executions).toBe(0);
  });

  it('registers, settles and replays without consulting Redis', async () => {
    const key = nextKey();
    const body = { amount: 100, currency: 'USD' };

    const first = await post(key, body);
    const second = await post(key, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(IdempotencyRedisDownController.executions).toBe(1);

    const record = await readRow(key);
    expect(record?.status).toBe('SETTLED');
    expect(record?.response_status).toBe(201);
    expect(record?.billing_intent_id).toBe((first.body as { id: string }).id);
  });

  it('returns 409 for the same key with a different payload', async () => {
    const key = nextKey();

    const first = await post(key, { amount: 100, currency: 'USD' });
    const second = await post(key, { amount: 200, currency: 'USD' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });
    expect(IdempotencyRedisDownController.executions).toBe(1);
  });

  it('returns 423 with Retry-After while the operation is in flight', async () => {
    const key = nextKey();
    await repository.registerOrGet(
      key,
      hashCanonicalPayload({ currency: 'USD', amount: 100 }),
      'SUBSCRIPTION_CREATE',
    );

    const response = await post(key, { amount: 100, currency: 'USD' });

    expect(response.status).toBe(423);
    expect(response.body).toMatchObject({
      error: 'IDEMPOTENCY_LOCKED',
      status: 'PROCESSING',
    });
    expect(response.headers['retry-after']).toMatch(/^\d+$/);
    expect(IdempotencyRedisDownController.executions).toBe(0);
  });

  it('rolls back a crashed effect and retakes after the lease expires', async () => {
    const key = nextKey();
    const body = { amount: 1500, currency: 'USD' };

    const first = await postCrash(key, body);

    expect(first.status).toBe(500);
    expect(IdempotencyRedisDownCrashController.executions).toBe(1);

    const crashed = await readRow(key);
    expect(crashed?.status).toBe('PROCESSING');
    expect(crashed?.settled_at).toBeNull();
    await expect(subscriptionCount(CRASH_ANCHOR)).resolves.toBe(0);

    await expireLease(key);

    const second = await postCrash(key, body);

    expect(second.status).toBe(201);
    expect(IdempotencyRedisDownCrashController.executions).toBe(2);
    await expect(subscriptionCount(CRASH_ANCHOR)).resolves.toBe(1);

    const settled = await readRow(key);
    expect(settled?.status).toBe('SETTLED');
    expect(settled?.response_status).toBe(201);
  });
});
