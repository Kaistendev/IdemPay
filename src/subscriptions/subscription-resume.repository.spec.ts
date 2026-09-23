import type { Pool } from 'pg';
import { SubscriptionCancellationRepository } from './subscription-cancellation.repository';

interface FakeQueryResult {
  rows: unknown[];
  rowCount?: number;
}

class FakeClient {
  readonly statements: string[] = [];
  private readonly responses: FakeQueryResult[];
  private readonly failAt: number | null;

  constructor(responses: FakeQueryResult[] = [], failAt: number | null = null) {
    this.responses = [...responses];
    this.failAt = failAt;
  }

  query(sql: string): { rows: unknown[]; rowCount: number } {
    this.statements.push(sql);
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

describe('SubscriptionResumeRepository', () => {
  it('sets the subscription back to ACTIVE in a transaction', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'sub-1' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyResume('sub-1');

    expect(result).toEqual({ id: 'sub-1' });
    expect(client.statements[0]).toBe('BEGIN');
    expect(client.statements[1]).toContain("status = 'ACTIVE'");
    expect(client.statements[2]).toBe('COMMIT');
  });

  it('returns null when the subscription is not found', async () => {
    const client = new FakeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    const result = await repository.applyResume('missing');

    expect(result).toBeNull();
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back the transaction when the update fails', async () => {
    const client = new FakeClient(undefined, 2);
    const repository = new SubscriptionCancellationRepository(
      poolWithConnecting(client),
    );

    await expect(repository.applyResume('sub-1')).rejects.toThrow('boom');
    expect(client.statements.some((sql) => sql === 'ROLLBACK')).toBe(true);
  });
});
