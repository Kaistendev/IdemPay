// T52 — Admin: Cancel (API): @RF-28
import type { Pool } from 'pg';
import { SubscriptionCancellationRepository } from './subscription-cancellation.repository';

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakeClient {
  readonly statements: string[] = [];
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  private readonly responses: FakeQueryResult[];
  private readonly failAt: number | null;

  constructor(responses: FakeQueryResult[] = [], failAt: number | null = null) {
    this.responses = [...responses];
    this.failAt = failAt;
  }

  query(
    sql: string,
    params: readonly unknown[] = [],
  ): { rows: unknown[]; rowCount: number } {
    this.statements.push(sql);
    this.calls.push({ sql, params: [...params] });
    if (this.failAt !== null && this.statements.length === this.failAt) {
      throw new Error('boom');
    }
    const next = this.responses.shift();
    const rows = next?.rows ?? [];
    const rowCount = next?.rowCount ?? rows.length;
    return { rows, rowCount };
  }

  release(): void {}
}

function poolWithConnecting(client: FakeClient): Pool {
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

const cancelledAt = new Date('2026-05-12T10:00:00Z');

describe('SubscriptionCancellationRepository', () => {
  it('appends a CancellationEvent in the same transaction as the cancellation', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ cancelledAt }], rowCount: 1 },
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyCancellation('sub-1', [
      'int-1',
      'int-2',
    ]);

    expect(result).toEqual({ cancelledAt, omittedCount: 2 });
    const eventCall = client.calls.find((call) =>
      call.sql.includes('INSERT INTO notifications'),
    );
    expect(eventCall).toBeDefined();
    expect(eventCall.params).toEqual([
      'sub-1',
      { subscriptionId: 'sub-1', reason: 'ADMIN' },
    ]);

    const beginIndex = client.statements.indexOf('BEGIN');
    const commitIndex = client.statements.indexOf('COMMIT');
    const eventIndex = client.statements.findIndex((sql) =>
      sql.includes('INSERT INTO notifications'),
    );
    expect(eventIndex).toBeGreaterThan(beginIndex);
    expect(eventIndex).toBeLessThan(commitIndex);
  });

  it('returns null without emitting an event when the subscription is not found', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyCancellation('missing', []);

    expect(result).toBeNull();
    expect(
      client.statements.some((sql) =>
        sql.includes('INSERT INTO notifications'),
      ),
    ).toBe(false);
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back the whole transaction when the event insert fails', async () => {
    const client = new FakeClient(
      [
        { rows: [], rowCount: 0 },
        { rows: [{ cancelledAt }], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ],
      4,
    );
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    await expect(
      repository.applyCancellation('sub-1', ['int-1']),
    ).rejects.toThrow('boom');
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
    expect(client.statements.some((sql) => sql === 'COMMIT')).toBe(false);
  });
});
