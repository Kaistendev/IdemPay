import { NotFoundException } from '@nestjs/common';
import { TransitionsService } from '../transitions/transitions.service';
import type {
  SubscriptionCancellationPort,
  SubscriptionCancellationResult,
  SubscriptionLifecycleSnapshot,
} from './subscriptions.types';
import { SubscriptionLifecycleService } from './subscriptions.lifecycle.service';

const cancelledAt = new Date('2026-05-12T10:00:00Z');

const snapshot = (
  overrides: Partial<SubscriptionLifecycleSnapshot> = {},
): SubscriptionLifecycleSnapshot => ({
  id: 'sub-1',
  status: 'ACTIVE',
  cancelledAt: null,
  liveIntents: [
    { id: 'int-scheduled', status: 'SCHEDULED' },
    { id: 'int-retry', status: 'RETRY_PENDING' },
    { id: 'int-in-flight', status: 'IN_FLIGHT' },
  ],
  ...overrides,
});

class FakeLifecycleRepository implements SubscriptionCancellationPort {
  current: SubscriptionLifecycleSnapshot | null;
  readonly persistCalls: Array<{ id: string; omittedIntentIds: string[] }> = [];
  readonly changedIntents: string[] = [];
  applyResult = { cancelledAt, omittedCount: 0 };

  constructor(current: SubscriptionLifecycleSnapshot | null) {
    this.current = current;
  }

  load(id: string): Promise<SubscriptionLifecycleSnapshot | null> {
    return Promise.resolve(this.current?.id === id ? this.current : null);
  }

  applyCancellation(
    id: string,
    omittedIntentIds: readonly string[],
  ): Promise<{ cancelledAt: Date; omittedCount: number } | null> {
    this.persistCalls.push({ id, omittedIntentIds: [...omittedIntentIds] });
    this.changedIntents.push(...omittedIntentIds);
    return Promise.resolve({
      cancelledAt: new Date(cancelledAt.getTime() + 86_400_000),
      omittedCount: omittedIntentIds.length,
    });
  }
}

describe('SubscriptionLifecycleService', () => {
  const transitions = new TransitionsService();

  const serviceFor = (repository: SubscriptionCancellationPort) =>
    new SubscriptionLifecycleService(repository, transitions);

  it('omits SCHEDULED and RETRY_PENDING intents with the cancellation reason and keeps an IN_FLIGHT intent untouched', async () => {
    const repository = new FakeLifecycleRepository(snapshot());
    const service = serviceFor(repository);

    expect(() =>
      transitions.assertTransition('billingIntent', 'IN_FLIGHT', 'OMITTED'),
    ).toThrow();

    const result: SubscriptionCancellationResult =
      await service.cancel('sub-1');

    expect(result).toEqual({
      id: 'sub-1',
      status: 'CANCELLED',
      cancelledAt: new Date(cancelledAt.getTime() + 86_400_000),
      omittedIntents: 2,
    });
    expect(repository.persistCalls).toEqual([
      { id: 'sub-1', omittedIntentIds: ['int-scheduled', 'int-retry'] },
    ]);
    expect(repository.changedIntents).not.toContain('int-in-flight');
  });

  it('does not request any change for a live intent in flight, preserving its eventual result', async () => {
    const repository = new FakeLifecycleRepository(snapshot());
    const service = serviceFor(repository);
    repository.current = {
      ...snapshot(),
      liveIntents: [{ id: 'int-in-flight', status: 'IN_FLIGHT' }],
    };

    await service.cancel('sub-1');

    expect(repository.persistCalls).toEqual([
      { id: 'sub-1', omittedIntentIds: [] },
    ]);
    expect(repository.changedIntents).toEqual([]);
  });

  it('is a no-op for an already CANCELLED subscription', async () => {
    const repository = new FakeLifecycleRepository(
      snapshot({
        status: 'CANCELLED',
        cancelledAt,
        liveIntents: [{ id: 'int-scheduled', status: 'SCHEDULED' }],
      }),
    );
    const service = serviceFor(repository);

    const result = await service.cancel('sub-1');

    expect(result).toEqual({
      id: 'sub-1',
      status: 'CANCELLED',
      cancelledAt,
      omittedIntents: 0,
    });
    expect(repository.persistCalls).toEqual([]);
  });

  it('cancels a PAUSED subscription and omits its pending intents', async () => {
    const repository = new FakeLifecycleRepository(
      snapshot({
        status: 'PAUSED',
        liveIntents: [{ id: 'int-retry', status: 'RETRY_PENDING' }],
      }),
    );
    const service = serviceFor(repository);

    const result = await service.cancel('sub-1');

    expect(result.status).toBe('CANCELLED');
    expect(result.omittedIntents).toBe(1);
    expect(repository.persistCalls).toEqual([
      { id: 'sub-1', omittedIntentIds: ['int-retry'] },
    ]);
  });

  it('throws NOT_FOUND when the subscription does not exist', async () => {
    const service = serviceFor(new FakeLifecycleRepository(null));

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
