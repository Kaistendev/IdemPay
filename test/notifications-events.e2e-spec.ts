import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ChargeExecutorService } from '../src/charge-executor/charge-executor.service';
import { PAYMENT_SCENARIO } from '../src/gateway/payment-scenario';
import { PG_POOL } from '../src/health/health.constants';

interface OutboxEventResponse {
  id: string;
  type: string;
  aggregateId: string;
  payload: { subscriptionId: string; billingIntentId?: string; reason: string };
  status: string;
  createdAt: string;
}

describe('notifications outbox query (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  const seededAggregates: string[] = [];

  const seedEvent = async (
    aggregateId: string,
    reason = 'FAILED_FINAL',
  ): Promise<string> => {
    if (!seededAggregates.includes(aggregateId)) {
      seededAggregates.push(aggregateId);
    }
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO notifications (type, aggregate_id, payload)
       VALUES ('CancellationEvent', $1, $2)
       RETURNING id`,
      [aggregateId, { subscriptionId: aggregateId, reason }],
    );
    return rows[0].id;
  };

  const getEvents = (query: string) =>
    request(app.getHttpServer()).get(`/notifications/events${query}`);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    if (seededAggregates.length > 0) {
      await pool.query(
        'DELETE FROM notifications WHERE aggregate_id = ANY($1::uuid[])',
        [seededAggregates],
      );
    }
    await app.close();
  });

  it('returns every event as PENDING without filters', async () => {
    const first = await seedEvent('00000000-0000-0000-0000-000000000011');
    const second = await seedEvent('00000000-0000-0000-0000-000000000012');

    const response = await getEvents('');

    expect(response.status).toBe(200);
    const body = response.body as { events: OutboxEventResponse[] };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    for (const event of body.events) {
      expect(event).toMatchObject({
        type: 'CancellationEvent',
        status: 'PENDING',
      });
      expect(event.payload).toMatchObject({ reason: 'FAILED_FINAL' });
      expect(typeof event.id).toBe('string');
      expect(typeof event.aggregateId).toBe('string');
      expect(typeof event.createdAt).toBe('string');
    }
    expect(body.events.map((event) => event.id)).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it('filters events by type', async () => {
    const target = await seedEvent('00000000-0000-0000-0000-000000000021');

    const response = await getEvents('?type=CancellationEvent');

    expect(response.status).toBe(200);
    const body = response.body as { events: OutboxEventResponse[] };
    expect(body.events.map((event) => event.id)).toContain(target);
    expect(
      body.events.every((event) => event.type === 'CancellationEvent'),
    ).toBe(true);
  });

  it('filters events by aggregateId', async () => {
    const wanted = '00000000-0000-0000-0000-000000000031';
    const unwanted = '00000000-0000-0000-0000-000000000032';
    const target = await seedEvent(wanted);
    await seedEvent(unwanted);

    const response = await getEvents(`?aggregateId=${wanted}`);

    expect(response.status).toBe(200);
    const body = response.body as { events: OutboxEventResponse[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ id: target, aggregateId: wanted });
  });

  it('combines the type and aggregateId filters', async () => {
    const wanted = '00000000-0000-0000-0000-000000000041';
    await seedEvent(wanted);

    const response = await getEvents(
      `?type=CancellationEvent&aggregateId=${wanted}`,
    );

    expect(response.status).toBe(200);
    const body = response.body as { events: OutboxEventResponse[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].aggregateId).toBe(wanted);
  });

  it('returns an empty list when nothing matches', async () => {
    const response = await getEvents(
      '?aggregateId=00000000-0000-0000-0000-000000000099',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ events: [] });
  });

  it('rejects a malformed aggregateId with 400', async () => {
    const response = await getEvents('?aggregateId=not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"aggregateId"');
  });

  it('rejects an unknown event type with 400', async () => {
    const response = await getEvents('?type=RefundEvent');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response.text).toContain('"path":"type"');
  });
});

describe('T43 CancellationEvent retrievable through the outbox API (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let pool: Pool;
  let executor: ChargeExecutorService;
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

  const createIntent = async (subscriptionId: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status)
       VALUES ($1, '2026-05-10', '2026-05-10'::date, 100, 'USD', 'SCHEDULED')
       RETURNING id`,
      [subscriptionId],
    );
    return rows[0].id;
  };

  const cleanup = async () => {
    if (createdSubscriptions.length > 0) {
      await pool.query(
        'DELETE FROM notifications WHERE aggregate_id = ANY($1::uuid[])',
        [createdSubscriptions],
      );
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
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_SCENARIO)
      .useValue('DECLINED')
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    executor = moduleRef.get(ChargeExecutorService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  it('exposes the CancellationEvent produced by T43 through the API', async () => {
    const subscriptionId = await createSubscription();
    const intentId = await createIntent(subscriptionId);

    const result = await executor.execute(intentId);
    expect(result).toMatchObject({ outcome: 'FAILED_FINAL' });

    const response = await request(app.getHttpServer()).get(
      `/notifications/events?aggregateId=${subscriptionId}`,
    );

    expect(response.status).toBe(200);
    const body = response.body as { events: OutboxEventResponse[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      type: 'CancellationEvent',
      aggregateId: subscriptionId,
      status: 'PENDING',
    });
    expect(body.events[0].payload).toMatchObject({
      subscriptionId,
      billingIntentId: intentId,
      reason: 'FAILED_FINAL',
    });
  });
});
