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
  ):
    | { rows: unknown[]; rowCount: number }
    | Promise<{ rows: unknown[]; rowCount: number }> {
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

  async release(): Promise<void> {}
}

function poolWithConnecting(client: FakeClient): Pool {
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}

function poolWithQuery(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

describe('SubscriptionPauseRepository', () => {
  it('loads a subscription snapshot with its live intents', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'sub-1', status: 'ACTIVE', cancelledAt: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'int-1', status: 'SCHEDULED' },
          { id: 'int-2', status: 'RETRY_PENDING' },
        ],
      });
    const repository = new SubscriptionCancellationRepository(
      poolWithQuery(query),
    );

    const snapshot = await repository.load('sub-1');

    expect(snapshot).toEqual({
      id: 'sub-1',
      status: 'ACTIVE',
      cancelledAt: null,
      liveIntents: [
        { id: 'int-1', status: 'SCHEDULED' },
        { id: 'int-2', status: 'RETRY_PENDING' },
      ],
    });
  });

  it('applies the pause and omits the target intents in the same transaction', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'sub-1' }], rowCount: 1 },
      { rows: [], rowCount: 2 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyPause('sub-1', ['int-1', 'int-2']);

    expect(result).toEqual({ omittedCount: 2 });
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain("status = 'PAUSED'");
    const omittedCall = client.calls.find((call) =>
      call.sql.includes('UPDATE billing_intents'),
    );
    expect(omittedCall?.params).toContain('SUBSCRIPTION_PAUSED');
    expect(client.statements[3]).toBe('COMMIT');
  });

  it('returns null when the subscription is not found', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyPause('missing', []);

    expect(result).toBeNull();
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back the transaction when the intent update fails', async () => {
    const client = new FakeClient(
      [
        { rows: [], rowCount: 0 },
        { rows: [{ id: 'sub-1' }], rowCount: 1 },
      ],
      3,
    );
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    await expect(repository.applyPause('sub-1', ['int-1'])).rejects.toThrow(
      'boom',
    );
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });
});
