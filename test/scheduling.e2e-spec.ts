import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Client, Pool } from 'pg';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { Clock } from '../src/common/time/clock';
import { CLOCK } from '../src/common/time/clock';
import { MigrationRunner } from '../src/database/migration-runner';
import { PG_POOL } from '../src/health/health.constants';
import { BillingSchedulerService } from '../src/scheduler/billing-scheduler.service';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';
const TODAY = '2026-03-10T12:00:00.000Z';
const LIVE_CYCLE = '2026-01-10';

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
}

describe('engine down omission (e2e)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let admin: Client;
  let pool: Pool;
  let calculatorPool: Pool;
  let scheduler: BillingSchedulerService;
  let clock: MutableClock;
  const schema = `t59_${process.pid}_${Date.now()}`;
  const createdSubscriptions: string[] = [];

  const createSubscription = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-01-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    createdSubscriptions.push(rows[0].id);
    return rows[0].id;
  };

  const insertLiveIntent = async (subscriptionId: string): Promise<void> => {
    await pool.query(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency, status, next_attempt_at)
       VALUES ($1, $2, $3::date, 100, 'USD', 'RETRY_PENDING',
               now() - interval '1 hour')`,
      [subscriptionId, LIVE_CYCLE, LIVE_CYCLE],
    );
  };

  const readIntents = async (subscriptionId: string) => {
    const { rows } = await pool.query<{
      cycle: string;
      scheduleDate: string;
      status: string;
      omittedReason: string | null;
    }>(
      `SELECT billing_cycle AS "cycle",
              to_char(schedule_date, 'YYYY-MM-DD') AS "scheduleDate",
              status,
              omitted_reason AS "omittedReason"
       FROM billing_intents WHERE subscription_id = $1
       ORDER BY billing_cycle`,
      [subscriptionId],
    );
    return rows;
  };

  const cleanup = async () => {
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
      createdSubscriptions.length = 0;
    }
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: CONNECTION_STRING });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    calculatorPool = new Pool({
      connectionString: CONNECTION_STRING,
      options: `-c search_path=${schema}`,
    });
    const runner = new MigrationRunner(calculatorPool);
    await runner.run();

    clock = new MutableClock(TODAY);
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(PG_POOL)
      .useValue(calculatorPool)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    pool = moduleRef.get<Pool>(PG_POOL);
    scheduler = moduleRef.get(BillingSchedulerService);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('omits missed cycles as ENGINE_DOWN and schedules the current cycle from the original anchor // T59: @E2E-10 @RF-18 @RF-23 @RF-31', async () => {
    const subscriptionId = await createSubscription();

    await scheduler.sweep();

    const intents = await readIntents(subscriptionId);
    expect(intents).toEqual([
      {
        cycle: '2026-01-10',
        scheduleDate: '2026-01-12',
        status: 'OMITTED',
        omittedReason: 'ENGINE_DOWN',
      },
      {
        cycle: '2026-02-10',
        scheduleDate: '2026-02-10',
        status: 'OMITTED',
        omittedReason: 'ENGINE_DOWN',
      },
      {
        cycle: '2026-03-10',
        scheduleDate: '2026-03-10',
        status: 'SCHEDULED',
        omittedReason: null,
      },
    ]);

    await scheduler.sweep();
    expect(await readIntents(subscriptionId)).toHaveLength(3);
  });

  it('never starts the next cycle while a live intent exists and omits it as OVERLAP at N+2 // T59: @E2E-15 @RF-14', async () => {
    const subscriptionId = await createSubscription();
    await insertLiveIntent(subscriptionId);

    clock.set('2026-02-10T12:00:00.000Z');
    await scheduler.sweep();

    const afterNextCycle = await readIntents(subscriptionId);
    expect(afterNextCycle).toEqual([
      {
        cycle: LIVE_CYCLE,
        scheduleDate: LIVE_CYCLE,
        status: 'RETRY_PENDING',
        omittedReason: null,
      },
    ]);

    clock.set('2026-03-10T12:00:00.000Z');
    await scheduler.sweep();

    const afterOverlap = await readIntents(subscriptionId);
    expect(afterOverlap).toEqual([
      {
        cycle: LIVE_CYCLE,
        scheduleDate: LIVE_CYCLE,
        status: 'RETRY_PENDING',
        omittedReason: null,
      },
      {
        cycle: '2026-02-10',
        scheduleDate: '2026-02-10',
        status: 'OMITTED',
        omittedReason: 'OVERLAP',
      },
    ]);
  });
});
