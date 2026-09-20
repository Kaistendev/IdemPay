import { Client, Pool } from 'pg';
import { MigrationRunner } from '../src/database/migration-runner';
import { MIGRATIONS } from '../src/database/migrations';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';

interface IntentInput {
  subscription_id: string;
  billing_cycle: string;
  schedule_date: string;
  amount: number;
  currency: string;
  status: string;
  origin_idempotency_key: string | null;
  settled_at: string | null;
  omitted_reason: string | null;
  next_attempt_at: string | null;
}

interface AttemptInput {
  billing_intent_id: string;
  trigger: 'AUTO' | 'MANUAL';
  auto_seq: number | null;
  provider_operation_id: string;
  status: string;
  error_type: string | null;
  finished_at: string | null;
}

describe('billing intents migration (e2e)', () => {
  const schema = `t10_${process.pid}_${Date.now()}`;
  const settledAt = '2026-03-01T00:00:00Z';
  let admin: Client;
  let pool: Pool;
  let runner: MigrationRunner;
  let applied: string[];
  let cycleSeq = 0;
  let providerSeq = 0;

  const nextCycle = (): string => {
    cycleSeq += 1;
    const month = String((Math.floor((cycleSeq - 1) / 28) % 12) + 1).padStart(
      2,
      '0',
    );
    const day = String(((cycleSeq - 1) % 28) + 1).padStart(2, '0');
    return `2026-${month}-${day}`;
  };

  const nextProviderOperation = (): string => {
    providerSeq += 1;
    return `po-${providerSeq}`;
  };

  const createSubscription = async (): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions
         (amount, currency, frequency, anchor_date, timezone, status)
       VALUES (100, 'USD', 'monthly', '2026-01-10', 'UTC', 'ACTIVE')
       RETURNING id`,
    );
    return rows[0].id;
  };

  const insertIntent = (
    subscriptionId: string,
    overrides: Partial<IntentInput> = {},
  ) => {
    const cycle = nextCycle();
    const input: IntentInput = {
      subscription_id: subscriptionId,
      billing_cycle: cycle,
      schedule_date: cycle,
      amount: 100,
      currency: 'USD',
      status: 'SCHEDULED',
      origin_idempotency_key: null,
      settled_at: null,
      omitted_reason: null,
      next_attempt_at: null,
      ...overrides,
    };
    return pool.query<{ id: string }>(
      `INSERT INTO billing_intents
         (subscription_id, billing_cycle, schedule_date, amount, currency,
          status, origin_idempotency_key, settled_at, omitted_reason, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.subscription_id,
        input.billing_cycle,
        input.schedule_date,
        input.amount,
        input.currency,
        input.status,
        input.origin_idempotency_key,
        input.settled_at,
        input.omitted_reason,
        input.next_attempt_at,
      ],
    );
  };

  const insertAttempt = (
    intentId: string,
    overrides: Partial<AttemptInput> = {},
  ) => {
    const input: AttemptInput = {
      billing_intent_id: intentId,
      trigger: 'AUTO',
      auto_seq: 1,
      provider_operation_id: nextProviderOperation(),
      status: 'IN_FLIGHT',
      error_type: null,
      finished_at: null,
      ...overrides,
    };
    return pool.query<{ id: string }>(
      `INSERT INTO payment_attempts
         (billing_intent_id, trigger, auto_seq, provider_operation_id, status,
          error_type, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.billing_intent_id,
        input.trigger,
        input.auto_seq,
        input.provider_operation_id,
        input.status,
        input.error_type,
        input.finished_at,
      ],
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
    runner = new MigrationRunner(pool);
    applied = await runner.run();
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('applies every migration from scratch', () => {
    expect(applied).toEqual(MIGRATIONS.map((migration) => migration.id));
  });

  it('enforces one billing intent per (subscription_id, billing_cycle)', async () => {
    const subscriptionId = await createSubscription();
    const cycle = '2026-03-01';

    await insertIntent(subscriptionId, {
      billing_cycle: cycle,
      schedule_date: cycle,
      status: 'OMITTED',
      settled_at: settledAt,
      omitted_reason: 'OVERLAP',
    });

    await expect(
      insertIntent(subscriptionId, {
        billing_cycle: cycle,
        schedule_date: cycle,
      }),
    ).rejects.toThrow(/billing_intents_identity_unique/);
  });

  it('allows only one live billing intent per subscription', async () => {
    const subscriptionId = await createSubscription();
    const first = await insertIntent(subscriptionId);

    await expect(insertIntent(subscriptionId)).rejects.toThrow(
      /billing_intents_live_unique/,
    );

    await pool.query(
      `UPDATE billing_intents
       SET status = 'OMITTED', omitted_reason = 'OVERLAP', settled_at = now()
       WHERE id = $1`,
      [first.rows[0].id],
    );

    const next = await insertIntent(subscriptionId);
    expect(next.rows[0].id).toBeTruthy();
  });

  it('enforces a unique auto sequence per billing intent', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await insertAttempt(intentId, {
      trigger: 'AUTO',
      auto_seq: 1,
      status: 'IN_FLIGHT',
    });

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 1,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_unique/);
  });

  it('bounds AUTO auto_seq between 1 and 5', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 0,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_check/);

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 6,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_check/);
  });

  it('keeps MANUAL attempts free of auto_seq and AUTO attempts bound to it', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await expect(
      insertAttempt(intentId, {
        trigger: 'MANUAL',
        auto_seq: 1,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_check/);

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: null,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_check/);

    const manual = await insertAttempt(intentId, {
      trigger: 'MANUAL',
      auto_seq: null,
      status: 'FAILED',
      finished_at: settledAt,
    });
    expect(manual.rows[0].id).toBeTruthy();
  });

  it('accepts a sixth attempt when it is MANUAL', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    for (let autoSeq = 1; autoSeq <= 5; autoSeq += 1) {
      await insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: autoSeq,
        status: 'FAILED',
        finished_at: settledAt,
      });
    }

    const manual = await insertAttempt(intentId, {
      trigger: 'MANUAL',
      auto_seq: null,
      status: 'FAILED',
      finished_at: settledAt,
    });
    expect(manual.rows[0].id).toBeTruthy();

    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM payment_attempts WHERE billing_intent_id = $1`,
      [intentId],
    );
    expect(rows[0].count).toBe(6);
  });

  it('rejects a sixth AUTO attempt', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    for (let autoSeq = 1; autoSeq <= 5; autoSeq += 1) {
      await insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: autoSeq,
        status: 'FAILED',
        finished_at: settledAt,
      });
    }

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 6,
        status: 'FAILED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_auto_seq_check/);
  });

  it('enforces a globally unique provider operation id', async () => {
    const firstSubscriptionId = await createSubscription();
    const secondSubscriptionId = await createSubscription();
    const firstIntent = (await insertIntent(firstSubscriptionId)).rows[0].id;
    const secondIntent = (await insertIntent(secondSubscriptionId)).rows[0].id;
    const providerOperationId = 'po-shared';

    await insertAttempt(firstIntent, {
      provider_operation_id: providerOperationId,
    });

    await expect(
      insertAttempt(secondIntent, {
        provider_operation_id: providerOperationId,
      }),
    ).rejects.toThrow(/payment_attempts_provider_operation_unique/);
  });

  it('allows at most one IN_FLIGHT attempt per billing intent', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await insertAttempt(intentId, {
      trigger: 'AUTO',
      auto_seq: 1,
      status: 'IN_FLIGHT',
    });

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 2,
        status: 'IN_FLIGHT',
      }),
    ).rejects.toThrow(/payment_attempts_in_flight_unique/);
  });

  it('allows at most one SUCCEEDED attempt per billing intent', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await insertAttempt(intentId, {
      trigger: 'AUTO',
      auto_seq: 1,
      status: 'SUCCEEDED',
      finished_at: settledAt,
    });

    await expect(
      insertAttempt(intentId, {
        trigger: 'AUTO',
        auto_seq: 2,
        status: 'SUCCEEDED',
        finished_at: settledAt,
      }),
    ).rejects.toThrow(/payment_attempts_succeeded_unique/);
  });

  it('rejects attempts that reference an unknown billing intent', async () => {
    await expect(
      insertAttempt('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/payment_attempts_billing_intent_id_fkey/);
  });

  it('rejects intents that reference an unknown subscription', async () => {
    await expect(
      insertIntent('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(/billing_intents_subscription_id_fkey/);
  });

  it('rejects unknown billing intent and payment attempt states', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await expect(
      insertIntent(subscriptionId, { status: 'PENDING' }),
    ).rejects.toThrow(/billing_intents_status_check/);

    await expect(
      insertAttempt(intentId, { status: 'PENDING', finished_at: settledAt }),
    ).rejects.toThrow(/payment_attempts_status_check/);
  });

  it('keeps settled_at consistent with the billing intent state', async () => {
    const subscriptionId = await createSubscription();

    await expect(
      insertIntent(subscriptionId, {
        status: 'SCHEDULED',
        settled_at: settledAt,
      }),
    ).rejects.toThrow(/billing_intents_settled_at_consistent/);

    await expect(
      insertIntent(subscriptionId, { status: 'SUCCEEDED', settled_at: null }),
    ).rejects.toThrow(/billing_intents_settled_at_consistent/);
  });

  it('keeps finished_at consistent with the payment attempt state', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await expect(
      insertAttempt(intentId, { status: 'IN_FLIGHT', finished_at: settledAt }),
    ).rejects.toThrow(/payment_attempts_finished_at_consistent/);

    await expect(
      insertAttempt(intentId, { status: 'FAILED', finished_at: null }),
    ).rejects.toThrow(/payment_attempts_finished_at_consistent/);
  });

  it('never lets a SUCCEEDED billing intent transition', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (
      await insertIntent(subscriptionId, {
        status: 'SUCCEEDED',
        settled_at: settledAt,
      })
    ).rows[0].id;

    await expect(
      pool.query(
        `UPDATE billing_intents SET status = 'IN_FLIGHT' WHERE id = $1`,
        [intentId],
      ),
    ).rejects.toThrow(/SUCCEEDED billing intent cannot transition/);
  });

  it('keeps billing intent identity, amount and currency immutable', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;

    await expect(
      pool.query(`UPDATE billing_intents SET amount = 200 WHERE id = $1`, [
        intentId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`UPDATE billing_intents SET currency = 'EUR' WHERE id = $1`, [
        intentId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('never lets a SUCCEEDED payment attempt transition', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;
    const attemptId = (
      await insertAttempt(intentId, {
        status: 'SUCCEEDED',
        finished_at: settledAt,
      })
    ).rows[0].id;

    await expect(
      pool.query(
        `UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1`,
        [attemptId],
      ),
    ).rejects.toThrow(/SUCCEEDED payment attempt cannot transition/);
  });

  it('keeps the payment attempt provider operation identity immutable', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;
    const attemptId = (await insertAttempt(intentId)).rows[0].id;

    await expect(
      pool.query(
        `UPDATE payment_attempts SET provider_operation_id = 'po-changed' WHERE id = $1`,
        [attemptId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps the payment attempt trigger and auto_seq immutable', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (await insertIntent(subscriptionId)).rows[0].id;
    const attemptId = (await insertAttempt(intentId)).rows[0].id;

    await expect(
      pool.query(
        `UPDATE payment_attempts SET trigger = 'MANUAL' WHERE id = $1`,
        [attemptId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`UPDATE payment_attempts SET auto_seq = 9 WHERE id = $1`, [
        attemptId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('accepts RETRY_PENDING and exposes the new scheduling fields', async () => {
    const subscriptionId = await createSubscription();
    const intentId = (
      await insertIntent(subscriptionId, {
        status: 'RETRY_PENDING',
        next_attempt_at: '2026-03-02T10:00:00Z',
      })
    ).rows[0].id;

    const { rows } = await pool.query<{
      status: string;
      next_attempt_at: Date | null;
      omitted_reason: string | null;
      unknown_since: Date | null;
      verify_count: number;
      next_verify_at: Date | null;
      needs_manual_review: boolean;
    }>(
      `SELECT status, next_attempt_at, omitted_reason, unknown_since,
              verify_count, next_verify_at, needs_manual_review
       FROM billing_intents WHERE id = $1`,
      [intentId],
    );

    expect(rows[0]).toMatchObject({
      status: 'RETRY_PENDING',
      omitted_reason: null,
      unknown_since: null,
      verify_count: 0,
      next_verify_at: null,
      needs_manual_review: false,
    });
    expect(rows[0].next_attempt_at).toBeInstanceOf(Date);
  });

  it('requires next_attempt_at only for RETRY_PENDING', async () => {
    const subscriptionId = await createSubscription();

    await expect(
      insertIntent(subscriptionId, { status: 'RETRY_PENDING' }),
    ).rejects.toThrow(/billing_intents_retry_pending_has_deadline/);

    const scheduled = await insertIntent(subscriptionId, {
      status: 'SCHEDULED',
      next_attempt_at: '2026-04-01T10:00:00Z',
    });
    expect(scheduled.rows[0].id).toBeTruthy();
  });

  it('requires omitted_reason on OMITTED and rejects invalid reasons', async () => {
    const subscriptionId = await createSubscription();

    await expect(
      insertIntent(subscriptionId, {
        status: 'OMITTED',
        settled_at: settledAt,
      }),
    ).rejects.toThrow(/billing_intents_omitted_reason_required/);

    await expect(
      insertIntent(subscriptionId, {
        status: 'OMITTED',
        settled_at: settledAt,
        omitted_reason: 'UNKNOWN',
      }),
    ).rejects.toThrow(/billing_intents_omitted_reason_valid/);

    await expect(
      insertIntent(subscriptionId, {
        status: 'SCHEDULED',
        omitted_reason: 'OVERLAP',
      }),
    ).rejects.toThrow(/billing_intents_omitted_reason_required/);

    const omitted = await insertIntent(subscriptionId, {
      status: 'OMITTED',
      settled_at: settledAt,
      omitted_reason: 'SUBSCRIPTION_CANCELLED',
    });
    expect(omitted.rows[0].id).toBeTruthy();
  });

  it('treats RETRY_PENDING as a live state for cycle overlap', async () => {
    const subscriptionId = await createSubscription();
    const first = await insertIntent(subscriptionId, {
      status: 'RETRY_PENDING',
      next_attempt_at: '2026-03-02T10:00:00Z',
    });

    await expect(insertIntent(subscriptionId)).rejects.toThrow(
      /billing_intents_live_unique/,
    );

    await pool.query(
      `UPDATE billing_intents
       SET status = 'OMITTED', omitted_reason = 'OVERLAP', settled_at = now()
       WHERE id = $1`,
      [first.rows[0].id],
    );

    const next = await insertIntent(subscriptionId);
    expect(next.rows[0].id).toBeTruthy();
  });
});
