import { NotFoundException } from '@nestjs/common';
import type { Clock } from '../common/time/clock';
import { TimeService } from '../common/time/time.service';
import { SubscriptionsQueryService } from './subscriptions.query.service';
import type {
  SubscriptionHistory,
  SubscriptionQueriesPort,
} from './subscriptions.types';

const NOW = new Date('2026-05-10T12:00:00Z');

class FakeSubscriptionQueries implements SubscriptionQueriesPort {
  constructor(private readonly history: SubscriptionHistory | null) {}

  findHistory(): Promise<SubscriptionHistory | null> {
    return Promise.resolve(this.history);
  }
}

const history = (
  overrides: Partial<SubscriptionHistory> = {},
): SubscriptionHistory => ({
  subscription: {
    id: 'sub-1',
    amount: '1500.000000',
    currency: 'USD',
    frequency: 'monthly',
    startDate: '2026-05-20',
    timezone: 'UTC',
    status: 'ACTIVE',
    createdAt: NOW,
    cancelledAt: null,
  },
  billingIntents: [
    {
      id: 'int-1',
      billingCycle: '2026-04-20',
      scheduleDate: '2026-04-20',
      amount: '1500.000000',
      currency: 'USD',
      status: 'FAILED_FINAL',
      settledAt: NOW,
      createdAt: NOW,
    },
    {
      id: 'int-2',
      billingCycle: '2026-05-20',
      scheduleDate: '2026-05-20',
      amount: '1500.000000',
      currency: 'USD',
      status: 'SCHEDULED',
      settledAt: null,
      createdAt: NOW,
    },
  ],
  paymentAttempts: [
    {
      id: 'att-1',
      billingIntentId: 'int-1',
      attemptNo: 1,
      providerOperationId: 'po-1',
      status: 'FAILED',
      errorType: 'DECLINED',
      startedAt: NOW,
      finishedAt: NOW,
    },
    {
      id: 'att-2',
      billingIntentId: 'int-1',
      attemptNo: 2,
      providerOperationId: 'po-2',
      status: 'FAILED',
      errorType: 'PROVIDER_ERROR',
      startedAt: NOW,
      finishedAt: NOW,
    },
  ],
  ...overrides,
});

describe('SubscriptionsQueryService', () => {
  const clock: Clock = { now: () => NOW };
  const time = new TimeService(clock, 'UTC');

  const serviceFor = (source: SubscriptionHistory | null) =>
    new SubscriptionsQueryService(new FakeSubscriptionQueries(source), time);

  it('returns the subscription, next billing date and full history', async () => {
    const result = await serviceFor(history()).findById('sub-1');

    expect(result).toMatchObject({
      id: 'sub-1',
      amount: 1500,
      currency: 'USD',
      frequency: 'monthly',
      startDate: '2026-05-20',
      timezone: 'UTC',
      status: 'ACTIVE',
      nextBillingDate: '2026-05-20',
      createdAt: NOW.toISOString(),
      cancelledAt: null,
    });

    expect(result.billingIntents).toHaveLength(2);
    expect(result.billingIntents[0]).toMatchObject({
      id: 'int-1',
      billingCycle: '2026-04-20',
      scheduleDate: '2026-04-20',
      amount: 1500,
      currency: 'USD',
      status: 'FAILED_FINAL',
      settledAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    });
    expect(result.billingIntents[0].attempts).toEqual([
      {
        id: 'att-1',
        attemptNo: 1,
        providerOperationId: 'po-1',
        status: 'FAILED',
        errorType: 'DECLINED',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      },
      {
        id: 'att-2',
        attemptNo: 2,
        providerOperationId: 'po-2',
        status: 'FAILED',
        errorType: 'PROVIDER_ERROR',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
      },
    ]);
    expect(result.billingIntents[1]).toMatchObject({
      id: 'int-2',
      status: 'SCHEDULED',
      settledAt: null,
      attempts: [],
    });
  });

  it('omits the next billing date for a CANCELLED subscription', async () => {
    const source = history();
    source.subscription = {
      ...source.subscription,
      status: 'CANCELLED',
      cancelledAt: NOW,
    };

    const result = await serviceFor(source).findById('sub-1');

    expect(result.status).toBe('CANCELLED');
    expect(result.nextBillingDate).toBeNull();
    expect(result.cancelledAt).toBe(NOW.toISOString());
  });

  it('omits the next billing date for a PAUSED subscription', async () => {
    const source = history();
    source.subscription = { ...source.subscription, status: 'PAUSED' };

    const result = await serviceFor(source).findById('sub-1');

    expect(result.status).toBe('PAUSED');
    expect(result.nextBillingDate).toBeNull();
  });

  it('throws NOT_FOUND when the subscription does not exist', async () => {
    const error = await serviceFor(null)
      .findById('missing')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      error: 'NOT_FOUND',
    });
  });
});
