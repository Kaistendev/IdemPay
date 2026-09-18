import { NotFoundException } from '@nestjs/common';
import { SubscriptionsCancellationService } from './subscriptions.cancellation.service';
import type {
  SubscriptionCancellationPort,
  SubscriptionCancellationResult,
} from './subscriptions.types';

const cancelledAt = new Date('2026-05-12T10:00:00Z');

class FakeCancellationRepository implements SubscriptionCancellationPort {
  readonly cancelled: string[] = [];

  constructor(private readonly result: SubscriptionCancellationResult | null) {}

  cancel(id: string): Promise<SubscriptionCancellationResult | null> {
    this.cancelled.push(id);
    return Promise.resolve(this.result);
  }
}

describe('SubscriptionsCancellationService', () => {
  it('cancels the subscription and omits the pending intents', async () => {
    const repository = new FakeCancellationRepository({
      id: 'sub-1',
      status: 'CANCELLED',
      cancelledAt,
      omittedIntents: 2,
    });
    const service = new SubscriptionsCancellationService(repository);

    const result = await service.cancel('sub-1');

    expect(result).toEqual({
      id: 'sub-1',
      status: 'CANCELLED',
      cancelledAt,
      omittedIntents: 2,
    });
    expect(repository.cancelled).toEqual(['sub-1']);
  });

  it('throws NOT_FOUND when the subscription does not exist', async () => {
    const repository = new FakeCancellationRepository(null);
    const service = new SubscriptionsCancellationService(repository);

    const error = await service
      .cancel('missing')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      error: 'NOT_FOUND',
    });
  });
});
