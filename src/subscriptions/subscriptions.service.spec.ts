import { BadRequestException } from '@nestjs/common';
import type { Clock } from '../common/time/clock';
import { TimeService } from '../common/time/time.service';
import { SubscriptionsService } from './subscriptions.service';
import type {
  CreateSubscriptionRequest,
  SubscriptionRecord,
  SubscriptionsRepositoryPort,
} from './subscriptions.types';

const NOW = new Date('2026-05-10T12:00:00Z');

class FakeSubscriptionsRepository implements SubscriptionsRepositoryPort {
  readonly inserted: CreateSubscriptionRequest[] = [];

  insert(input: CreateSubscriptionRequest): Promise<SubscriptionRecord> {
    this.inserted.push(input);
    return Promise.resolve({
      id: `sub-${this.inserted.length}`,
      amount: String(input.amount),
      currency: input.currency,
      frequency: input.frequency,
      startDate: input.startDate,
      timezone: input.timezone,
      status: 'ACTIVE',
      createdAt: NOW,
    });
  }
}

describe('SubscriptionsService', () => {
  const clock: Clock = { now: () => NOW };
  const time = new TimeService(clock, 'UTC');
  const baseRequest: CreateSubscriptionRequest = {
    amount: 1500,
    currency: 'USD',
    frequency: 'monthly',
    startDate: '2026-05-10',
    timezone: 'UTC',
  };

  let repository: FakeSubscriptionsRepository;
  let service: SubscriptionsService;

  beforeEach(() => {
    repository = new FakeSubscriptionsRepository();
    service = new SubscriptionsService(repository, time);
  });

  it('creates a subscription when startDate is today in the official clock', async () => {
    const result = await service.create(baseRequest);

    expect(result).toEqual({
      id: 'sub-1',
      amount: 1500,
      currency: 'USD',
      frequency: 'monthly',
      startDate: '2026-05-10',
      timezone: 'UTC',
      status: 'ACTIVE',
      createdAt: NOW.toISOString(),
    });
    expect(repository.inserted).toEqual([baseRequest]);
  });

  it('creates a subscription when startDate is in the future', async () => {
    const result = await service.create({
      ...baseRequest,
      startDate: '2026-06-01',
    });

    expect(result.startDate).toBe('2026-06-01');
    expect(repository.inserted).toHaveLength(1);
  });

  it('rejects a startDate in the past without persisting anything', async () => {
    const error = await service
      .create({ ...baseRequest, startDate: '2026-05-09' })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(response).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(response).toMatchObject({
      details: [{ path: 'startDate', code: 'not_allowed' }],
    });
    expect(repository.inserted).toHaveLength(0);
  });
});
