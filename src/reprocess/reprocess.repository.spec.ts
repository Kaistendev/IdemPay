import type { Pool } from 'pg';
import { ReprocessRepository } from './reprocess.repository';

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakeClient {
  readonly statements: string[] = [];
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private readonly responses: FakeQueryResult[];
  private readonly failAt: number | null;
  private readonly failError: unknown;

  constructor(
    responses: FakeQueryResult[] = [],
    failAt: number | null = null,
    failError: unknown = new Error('boom'),
  ) {
    this.responses = [...responses];
    this.failAt = failAt;
    this.failError = failError;
  }

  query(
    sql: string,
    params: readonly unknown[] = [],
  ): { rows: unknown[]; rowCount: number } {
    this.statements.push(sql);
    this.calls.push({ sql, params: [...params] });
    if (this.failAt !== null && this.statements.length === this.failAt) {
      throw this.failError;
    }
    const next = this.responses.shift();
    const rows = next?.rows ?? [];
    const rowCount = next?.rowCount ?? rows.length;
    return { rows, rowCount };
  }

  release(): void {}
}

describe('ReprocessRepository', () => {
  it('loads the intent together with its latest provider operation id', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'int-1',
          subscriptionId: 'sub-1',
          status: 'UNKNOWN',
          providerOperationId: 'op-1',
        },
      ],
    });
    const repository = new ReprocessRepository({
      query,
    } as unknown as Pool);

    const result = await repository.loadCandidate('sub-1', '2026-05-10');

    expect(result).toEqual({
      id: 'int-1',
      subscriptionId: 'sub-1',
      status: 'UNKNOWN',
      providerOperationId: 'op-1',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM billing_intents'),
      ['sub-1', '2026-05-10'],
    );
  });

  it('returns null when no intent exists for the cycle', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new ReprocessRepository({
      query,
    } as unknown as Pool);

    const result = await repository.loadCandidate('sub-1', '2026-05-10');

    expect(result).toBeNull();
  });

  it('closes an UNKNOWN intent as SUCCEEDED only while it is still UNKNOWN', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'int-1' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const closed = await repository.closeVerificationAsSucceeded('int-1');

    expect(closed).toBe(true);
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain("status = 'SUCCEEDED'");
    expect(client.statements[1]).toContain("status = 'UNKNOWN'");
    expect(client.statements[2]).toBe('COMMIT');
  });

  it('reports a missed close when the intent is no longer UNKNOWN', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const closed = await repository.closeVerificationAsSucceeded('int-1');

    expect(closed).toBe(false);
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('starts a MANUAL attempt on a FAILED_FINAL intent', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            status: 'FAILED_FINAL',
            amount: '100.000000',
            currency: 'USD',
          },
        ],
      },
      { rows: [{ manualSeq: 5 }] },
      { rows: [{ id: 'att-m1' }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const result = await repository.startManualAttempt('int-1');

    expect(result).toEqual({
      outcome: 'STARTED',
      billingIntentId: 'int-1',
      attemptId: 'att-m1',
      providerOperationId: 'int-1:manual:6',
      amount: 100,
      currency: 'USD',
    });
    expect(client.statements[1]).toContain('FOR UPDATE');
    const insert = client.calls.find((call) =>
      call.sql.includes('INSERT INTO payment_attempts'),
    );
    expect(insert?.params).toEqual(['int-1', 'int-1:manual:6', 60000]);
    expect(
      client.statements.some((sql) => sql.includes("status = 'IN_FLIGHT'")),
    ).toBe(true);
  });

  it('rejects starting a MANUAL attempt when the intent is not reprocessable', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            status: 'SUCCEEDED',
            amount: '100.000000',
            currency: 'USD',
          },
        ],
      },
      { rows: [{ manualSeq: 0 }] },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const result = await repository.startManualAttempt('int-1');

    expect(result).toEqual({
      outcome: 'NOT_ELIGIBLE',
      billingIntentId: 'int-1',
    });
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('returns NOT_FOUND when the intent no longer exists', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const result = await repository.startManualAttempt('int-1');

    expect(result).toEqual({ outcome: 'NOT_FOUND', billingIntentId: 'int-1' });
  });

  it('maps a concurrent IN_FLIGHT attempt to ALREADY_IN_FLIGHT', async () => {
    const client = new FakeClient(
      [
        { rows: [], rowCount: 0 },
        {
          rows: [{ status: 'UNKNOWN', amount: '100.000000', currency: 'USD' }],
        },
        { rows: [{ manualSeq: 3 }] },
      ],
      4,
      {
        message: 'duplicate key value violates unique constraint',
        code: '23505',
        constraint: 'payment_attempts_in_flight_unique',
      },
    );
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    const result = await repository.startManualAttempt('int-1');

    expect(result).toEqual({
      outcome: 'ALREADY_IN_FLIGHT',
      billingIntentId: 'int-1',
    });
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('settles a SUCCEEDED MANUAL attempt and settles the intent', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'IN_FLIGHT', subscriptionId: 'sub-1' }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    await repository.settleManualAttempt('int-1', 'att-m1', {
      outcome: 'SUCCEEDED',
    });

    expect(client.statements[1]).toContain('FOR UPDATE');
    const settle = client.calls.find((call) =>
      call.sql.includes('UPDATE billing_intents'),
    );
    expect(settle?.params).toEqual([
      'int-1',
      'SUCCEEDED',
      true,
      false,
      false,
      null,
    ]);
    expect(client.statements.some((sql) => sql === 'COMMIT')).toBe(true);
  });

  it('cancels the active subscription when a MANUAL attempt fails finally', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            status: 'IN_FLIGHT',
            subscriptionId: 'sub-1',
            subscriptionStatus: 'ACTIVE',
          },
        ],
      },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    await repository.settleManualAttempt('int-1', 'att-m1', {
      outcome: 'FAILED_FINAL',
      errorType: 'DECLINED',
    });

    expect(
      client.statements.some((sql) => sql.includes("SET status = 'CANCELLED'")),
    ).toBe(true);
    expect(
      client.statements.some((sql) => sql.includes("status = 'OMITTED'")),
    ).toBe(true);
    expect(
      client.statements.some((sql) => sql.includes('CancellationEvent')),
    ).toBe(true);
  });

  it('does not re-cancel nor re-emit when the subscription is already CANCELLED', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            status: 'IN_FLIGHT',
            subscriptionId: 'sub-1',
            subscriptionStatus: 'CANCELLED',
          },
        ],
      },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    await repository.settleManualAttempt('int-1', 'att-m1', {
      outcome: 'FAILED_FINAL',
      errorType: 'DECLINED',
    });

    expect(
      client.statements.some((sql) => sql.includes("SET status = 'CANCELLED'")),
    ).toBe(false);
    expect(
      client.statements.some((sql) => sql.includes('CancellationEvent')),
    ).toBe(false);
  });

  it('settles an UNKNOWN MANUAL attempt without touching the subscription', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ status: 'IN_FLIGHT', subscriptionId: 'sub-1' }] },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new ReprocessRepository({
      connect: () => Promise.resolve(client),
    } as unknown as Pool);

    await repository.settleManualAttempt('int-1', 'att-m1', {
      outcome: 'UNKNOWN',
    });

    const settle = client.calls.find((call) =>
      call.sql.includes('UPDATE billing_intents'),
    );
    expect(settle?.params).toEqual([
      'int-1',
      'UNKNOWN',
      false,
      true,
      false,
      null,
    ]);
    expect(
      client.statements.some((sql) => sql.includes('CancellationEvent')),
    ).toBe(false);
  });

  it('loads the intent view for a subscription cycle', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 'int-1',
          subscriptionId: 'sub-1',
          billingCycle: '2026-05-10',
          scheduleDate: '2026-05-10',
          amount: '100.000000',
          currency: 'USD',
          status: 'SUCCEEDED',
          omittedReason: null,
          settledAt: '2026-05-10T12:00:00.000Z',
        },
      ],
    });
    const repository = new ReprocessRepository({
      query,
    } as unknown as Pool);

    const result = await repository.findIntent('sub-1', '2026-05-10');

    expect(result).toMatchObject({
      id: 'int-1',
      subscriptionId: 'sub-1',
      billingCycle: '2026-05-10',
      status: 'SUCCEEDED',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM billing_intents'),
      ['sub-1', '2026-05-10'],
    );
  });
});
