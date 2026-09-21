import type { Pool, PoolClient } from 'pg';
import { IdempotencyUnitOfWork } from '../idempotency/idempotency.uow';
import type { CreateSubscriptionRequest } from './subscription.schema';
import { SubscriptionsRepository } from './subscriptions.repository';

const INPUT: CreateSubscriptionRequest = {
  amount: 1500,
  currency: 'USD',
  frequency: 'monthly',
  startDate: '2026-05-10',
  timezone: 'UTC',
};

const ROW = {
  id: 'sub-1',
  amount: '1500',
  currency: 'USD',
  frequency: 'monthly',
  startDate: '2026-05-10',
  timezone: 'UTC',
  status: 'ACTIVE',
  createdAt: new Date('2026-05-10T12:00:00Z'),
};

describe('SubscriptionsRepository', () => {
  it('runs the insert on the unit-of-work transaction client when inside one', async () => {
    const poolQuery = jest.fn();
    const pool = { query: poolQuery } as unknown as Pool;
    const clientQuery = jest.fn().mockResolvedValue({ rows: [ROW] });
    const client = { query: clientQuery } as unknown as PoolClient;
    const uow = new IdempotencyUnitOfWork();
    const repository = new SubscriptionsRepository(pool, uow);

    const result = await uow.run(client, () => repository.insert(INPUT));

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(result).toEqual(ROW);
  });

  it('falls back to the pool when no transaction is active', async () => {
    const poolQuery = jest.fn().mockResolvedValue({ rows: [ROW] });
    const pool = { query: poolQuery } as unknown as Pool;
    const uow = new IdempotencyUnitOfWork();
    const repository = new SubscriptionsRepository(pool, uow);

    const result = await repository.insert(INPUT);

    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ROW);
  });
});
