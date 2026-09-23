import type { Pool } from 'pg';
import { BillingSchedulerRepository } from './billing-scheduler.repository';
import type { SchedulableSubscription } from './billing-scheduler.types';

const SUBSCRIPTION_ROW = {
  id: 'sub-1',
  amount: '100.000000',
  currency: 'USD',
  frequency: 'monthly',
  anchorDate: '2026-01-10',
  status: 'ACTIVE',
};

const SUBSCRIPTION: SchedulableSubscription = {
  id: 'sub-1',
  amount: 100,
  currency: 'USD',
  frequency: 'monthly',
  anchorDate: '2026-01-10',
  status: 'ACTIVE',
};

function queryPool(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}

describe('BillingSchedulerRepository', () => {
  it('lists only ACTIVE subscriptions mapped to scheduler snapshots', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [SUBSCRIPTION_ROW] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const subscriptions = await repository.listActiveSubscriptions();

    expect(query).toHaveBeenCalledTimes(1);
    expect(subscriptions).toEqual([SUBSCRIPTION]);
  });

  it('returns the created intent snapshot when the insert succeeds', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'bi-1' }] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.scheduleIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-02-10',
      scheduleDate: '2026-02-10',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(intent).toEqual({
      id: 'bi-1',
      subscriptionId: 'sub-1',
      billingCycle: '2026-02-10',
      scheduleDate: '2026-02-10',
      amount: 100,
      currency: 'USD',
      status: 'SCHEDULED',
      omittedReason: null,
    });
  });

  it('returns null when the insert conflicts with an existing intent', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.scheduleIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-02-10',
      scheduleDate: '2026-02-10',
    });

    expect(intent).toBeNull();
  });

  it('lists every existing intent of a subscription with its status', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        { billing_cycle: '2026-01-10', status: 'SUCCEEDED' },
        { billing_cycle: '2026-02-10', status: 'RETRY_PENDING' },
      ],
    });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intents = await repository.listExistingIntents('sub-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('billing_intents'),
      ['sub-1'],
    );
    expect(intents).toEqual([
      { billingCycle: '2026-01-10', status: 'SUCCEEDED' },
      { billingCycle: '2026-02-10', status: 'RETRY_PENDING' },
    ]);
  });

  it('records an ENGINE_DOWN omitted intent when the insert succeeds', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'bi-2' }] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.omitEngineDownIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-01-31',
      scheduleDate: '2026-02-02',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(intent).toEqual({
      id: 'bi-2',
      subscriptionId: 'sub-1',
      billingCycle: '2026-01-31',
      scheduleDate: '2026-02-02',
      amount: 100,
      currency: 'USD',
      status: 'OMITTED',
      omittedReason: 'ENGINE_DOWN',
    });
  });

  it('returns null when the omission conflicts with an existing intent', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.omitEngineDownIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-01-31',
      scheduleDate: '2026-02-02',
    });

    expect(intent).toBeNull();
  });

  it('records an OVERLAP omitted intent when the insert succeeds', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'bi-3' }] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.omitOverlapIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-02-28',
      scheduleDate: '2026-03-02',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(intent).toEqual({
      id: 'bi-3',
      subscriptionId: 'sub-1',
      billingCycle: '2026-02-28',
      scheduleDate: '2026-03-02',
      amount: 100,
      currency: 'USD',
      status: 'OMITTED',
      omittedReason: 'OVERLAP',
    });
  });

  it('returns null when the overlap omission conflicts with an existing intent', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new BillingSchedulerRepository(queryPool(query));

    const intent = await repository.omitOverlapIntent({
      subscription: SUBSCRIPTION,
      billingCycle: '2026-02-28',
      scheduleDate: '2026-03-02',
    });

    expect(intent).toBeNull();
  });
});
