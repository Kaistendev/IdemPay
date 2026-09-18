import {
  Body,
  Controller,
  INestApplication,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types';
import { z } from 'zod';
import { CommonModule } from '../src/common/common.module';
import { hashCanonicalPayload } from '../src/common/idempotency/payload-hash';
import { ZodValidationPipe } from '../src/common/validation/zod-validation.pipe';
import { REDIS_CLIENT } from '../src/health/health.constants';
import { idempotencyRecordKey } from '../src/idempotency/idempotency.constants';
import { IdempotencyContext } from '../src/idempotency/idempotency.context';
import type { IdempotencyOperationContext } from '../src/idempotency/idempotency.context';
import { IdempotencyGuard } from '../src/idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../src/idempotency/idempotency.interceptor';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { IdempotencyStore } from '../src/idempotency/idempotency.store';

const chargeSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

type ChargeBody = z.infer<typeof chargeSchema>;

@Controller('idempotency-test')
class IdempotencyTestController {
  static executions = 0;

  @Post()
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  create(
    @Body(new ZodValidationPipe(chargeSchema)) body: ChargeBody,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): ChargeBody & { id: string } {
    IdempotencyTestController.executions += 1;
    const id = `bi-${IdempotencyTestController.executions}`;
    context.billingIntentRef = id;
    return { id, ...body };
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('IdempotencyGuard (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let store: IdempotencyStore;
  let redis: Redis;
  const runId = `t6-${process.pid}-${Date.now()}`;
  const createdKeys: string[] = [];
  let counter = 0;

  const nextKey = (): string => {
    counter += 1;
    const key = `${runId}-${counter}`;
    createdKeys.push(idempotencyRecordKey(key));
    return key;
  };

  const post = (key: string | undefined, body: Record<string, unknown>) => {
    const agent = request(app.getHttpServer())
      .post('/idempotency-test')
      .send(body);
    return key === undefined ? agent : agent.set('Idempotency-Key', key);
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CommonModule, IdempotencyModule],
      controllers: [IdempotencyTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    store = moduleRef.get(IdempotencyStore);
    redis = moduleRef.get<Redis>(REDIS_CLIENT);
  });

  beforeEach(() => {
    IdempotencyTestController.executions = 0;
  });

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await redis.del(...createdKeys);
    }
    await app.close();
  });

  it('returns 400 when the Idempotency-Key header is missing', async () => {
    const response = await post(undefined, { amount: 100, currency: 'USD' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(IdempotencyTestController.executions).toBe(0);
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
    expect(IdempotencyTestController.executions).toBe(1);
  });

  it('returns 423 while the operation is in flight', async () => {
    const key = nextKey();
    await store.begin(
      key,
      hashCanonicalPayload({ currency: 'USD', amount: 100 }),
    );

    const response = await post(key, { amount: 100, currency: 'USD' });

    expect(response.status).toBe(423);
    expect(response.body).toMatchObject({
      error: 'IDEMPOTENCY_LOCKED',
      status: 'PROCESSING',
    });
    expect(IdempotencyTestController.executions).toBe(0);
  });

  it('replays the settled response without executing again', async () => {
    const key = nextKey();
    const body = { amount: 100, currency: 'USD' };

    const first = await post(key, body);
    const second = await post(key, body);

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: 'bi-1', amount: 100, currency: 'USD' });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(IdempotencyTestController.executions).toBe(1);

    const record = await store.read(key);
    expect(record?.state).toBe('SETTLED');
  });

  it('allows a new operation after the key expires with no grace period', async () => {
    const key = nextKey();

    const first = await post(key, { amount: 100, currency: 'USD' });
    expect(first.status).toBe(201);

    await redis.pexpire(idempotencyRecordKey(key), 1);
    await wait(40);

    const second = await post(key, { amount: 200, currency: 'USD' });

    expect(second.status).toBe(201);
    expect(IdempotencyTestController.executions).toBe(2);
  });
});
