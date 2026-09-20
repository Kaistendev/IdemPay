import { Client, Pool } from 'pg';
import { MigrationRunner } from '../src/database/migration-runner';
import { MIGRATIONS } from '../src/database/migrations';

const CONNECTION_STRING =
  process.env.DATABASE_URL ?? 'postgresql://idem:idem@localhost:5433/idem';

const CREATED_AT = '2026-01-01T00:00:00Z';
const EXPIRES_AT = '2026-01-02T00:00:00Z';
const LEASE_EXPIRES_AT = '2026-01-01T00:05:00Z';
const SETTLED_AT = '2026-01-01T00:06:00Z';

interface OperationInput {
  key: string;
  generation: number;
  operation_type: string;
  payload_hash: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
  billing_intent_id: string | null;
  created_at: string;
  expires_at: string;
  lease_expires_at: string | null;
  settled_at: string | null;
}

describe('idempotency operations migration (e2e)', () => {
  const schema = `t23_${process.pid}_${Date.now()}`;
  let admin: Client;
  let pool: Pool;
  let runner: MigrationRunner;
  let applied: string[];
  let opSeq = 0;

  const nextOperation = (): string => {
    opSeq += 1;
    return `op-${opSeq}`;
  };

  const insertOperation = (overrides: Partial<OperationInput> = {}) => {
    const input: OperationInput = {
      key: nextOperation(),
      generation: 1,
      operation_type: 'SUBSCRIPTION_CREATE',
      payload_hash: `hash-${opSeq}`,
      status: 'PROCESSING',
      response_status: null,
      response_body: null,
      billing_intent_id: null,
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
      lease_expires_at: LEASE_EXPIRES_AT,
      settled_at: null,
      ...overrides,
    };
    return pool.query<{ id: string }>(
      `INSERT INTO idempotency_operations
         (key, generation, operation_type, payload_hash, status,
          response_status, response_body, billing_intent_id,
          created_at, expires_at, lease_expires_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.key,
        input.generation,
        input.operation_type,
        input.payload_hash,
        input.status,
        input.response_status,
        input.response_body,
        input.billing_intent_id,
        input.created_at,
        input.expires_at,
        input.lease_expires_at,
        input.settled_at,
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
    expect(applied).toContain('004-create-idempotency-operations');
  });

  it('is reproducible and idempotent when run again', async () => {
    const second = await runner.run();
    expect(second).toEqual([]);

    const migrations = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM schema_migrations',
    );
    expect(migrations.rows[0].count).toBe(MIGRATIONS.length);
  });

  it('registers a PROCESSING operation without a response', async () => {
    const { rows } = await insertOperation();
    expect(rows[0].id).toBeTruthy();
  });

  it('rejects a duplicate (key, generation)', async () => {
    const key = nextOperation();
    await insertOperation({ key, generation: 1 });

    await expect(insertOperation({ key, generation: 1 })).rejects.toThrow(
      /idempotency_operations_key_generation_unique/,
    );
  });

  it('allows the same key under a new generation (RF-04)', async () => {
    const key = nextOperation();
    await insertOperation({ key, generation: 1 });
    await insertOperation({
      key,
      generation: 2,
      payload_hash: `hash-${opSeq}`,
    });
  });

  it('rejects SETTLED without a stored response', async () => {
    await expect(
      insertOperation({
        status: 'SETTLED',
        response_status: null,
        response_body: null,
        lease_expires_at: null,
        settled_at: SETTLED_AT,
      }),
    ).rejects.toThrow(/idempotency_operations_settled_consistent/);
  });

  it('rejects a stored response while still PROCESSING', async () => {
    await expect(
      insertOperation({
        status: 'PROCESSING',
        response_status: 201,
        response_body: { id: 'any' },
      }),
    ).rejects.toThrow(/idempotency_operations_processing_no_response/);
  });

  it('settles a PROCESSING operation with the full response', async () => {
    const { rows } = await insertOperation();
    const id = rows[0].id;

    const settled = await pool.query<{ status: string; settled_at: Date }>(
      `UPDATE idempotency_operations
         SET status = 'SETTLED',
             response_status = 201,
             response_body = $2,
             settled_at = $3,
             lease_expires_at = NULL
       WHERE id = $1
       RETURNING status, settled_at`,
      [id, { status: 'created' }, SETTLED_AT],
    );

    expect(settled.rows[0].status).toBe('SETTLED');
    expect(settled.rows[0].settled_at).toBeInstanceOf(Date);
  });

  it('never lets a SETTLED operation revert (INV-06)', async () => {
    const { rows } = await insertOperation({
      status: 'SETTLED',
      response_status: 201,
      response_body: { status: 'created' },
      lease_expires_at: null,
      settled_at: SETTLED_AT,
    });

    await expect(
      pool.query(
        `UPDATE idempotency_operations
           SET status = 'PROCESSING', lease_expires_at = now()
         WHERE id = $1`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/SETTLED idempotency operation cannot transition/);
  });

  it('keeps the idempotency operation identity immutable', async () => {
    const { rows } = await insertOperation();

    await expect(
      pool.query(
        `UPDATE idempotency_operations SET payload_hash = 'changed' WHERE id = $1`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('rejects an unknown operation type', async () => {
    await expect(
      insertOperation({ operation_type: 'SUBSCRIPTION_DELETE' }),
    ).rejects.toThrow(/idempotency_operations_operation_type_check/);
  });

  it('rejects an unknown status', async () => {
    await expect(
      insertOperation({ status: 'PENDING', lease_expires_at: null }),
    ).rejects.toThrow(/idempotency_operations_status_check/);
  });

  it('rejects an empty or oversized idempotency key (RF-01)', async () => {
    await expect(insertOperation({ key: '' })).rejects.toThrow(
      /idempotency_operations_key_check/,
    );

    await expect(insertOperation({ key: 'x'.repeat(256) })).rejects.toThrow(
      /idempotency_operations_key_check/,
    );
  });

  it('requires a lease exactly while PROCESSING', async () => {
    await expect(insertOperation({ lease_expires_at: null })).rejects.toThrow(
      /idempotency_operations_lease_consistent/,
    );

    await expect(
      insertOperation({
        status: 'SETTLED',
        response_status: 200,
        response_body: { ok: true },
        lease_expires_at: LEASE_EXPIRES_AT,
        settled_at: SETTLED_AT,
      }),
    ).rejects.toThrow(/idempotency_operations_lease_consistent/);
  });

  it('requires settled_at exactly when SETTLED', async () => {
    await expect(
      insertOperation({
        status: 'SETTLED',
        response_status: 200,
        response_body: { ok: true },
        lease_expires_at: null,
        settled_at: null,
      }),
    ).rejects.toThrow(/idempotency_operations_settled_at_consistent/);

    await expect(insertOperation({ settled_at: SETTLED_AT })).rejects.toThrow(
      /idempotency_operations_settled_at_consistent/,
    );
  });

  it('requires expires_at after created_at', async () => {
    await expect(insertOperation({ expires_at: CREATED_AT })).rejects.toThrow(
      /idempotency_operations_expires_after_created/,
    );
  });

  it('keeps the operation nullable billing intent reference', async () => {
    const { rows } = await insertOperation({ billing_intent_id: null });
    expect(rows[0].id).toBeTruthy();
  });

  it('rejects an operation referencing an unknown billing intent', async () => {
    await expect(
      insertOperation({
        billing_intent_id: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/idempotency_operations_billing_intent_id_fkey/);
  });
});
