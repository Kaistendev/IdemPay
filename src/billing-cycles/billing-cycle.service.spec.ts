import { ConflictException, NotFoundException } from '@nestjs/common';
import type { IdempotencyOperationContext } from '../idempotency/idempotency.context';
import type {
  BillingCycleSubscriptionSnapshot,
  BillingIntentSnapshot,
  BillingCycleRepositoryPort,
  GetOrCreateIntentResult,
} from './billing-cycle.types';
import { BillingCycleChargeService } from './billing-cycle.service';

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `bi-${idCounter}`;
}

function snapshotFor(
  subscriptionId: string,
  billingCycle: string,
): BillingIntentSnapshot {
  return {
    id: nextId(),
    subscriptionId,
    billingCycle,
    scheduleDate: billingCycle,
    amount: 100,
    currency: 'USD',
    status: 'SCHEDULED',
    omittedReason: null,
    settledAt: null,
  };
}

class FakeRepository implements BillingCycleRepositoryPort {
  subscriptions = new Map<string, BillingCycleSubscriptionSnapshot>();
  intents: BillingIntentSnapshot[] = [];

  constructor(subscriptions: BillingCycleSubscriptionSnapshot[]) {
    for (const subscription of subscriptions) {
      this.subscriptions.set(subscription.id, subscription);
    }
  }

  findSubscription(
    id: string,
  ): Promise<BillingCycleSubscriptionSnapshot | null> {
    return Promise.resolve(this.subscriptions.get(id) ?? null);
  }

  getOrCreateIntent(input: {
    subscription: BillingCycleSubscriptionSnapshot;
    billingCycle: string;
    idempotencyKey: string;
  }): Promise<GetOrCreateIntentResult> {
    const existing = this.intents.find(
      (intent) =>
        intent.subscriptionId === input.subscription.id &&
        intent.billingCycle === input.billingCycle,
    );
    if (existing) {
      return Promise.resolve({ intent: existing, created: false });
    }
    if (input.subscription.status !== 'ACTIVE') {
      return Promise.resolve({ reason: 'SUBSCRIPTION_NOT_ACTIVE' });
    }
    const intent = snapshotFor(input.subscription.id, input.billingCycle);
    this.intents.push(intent);
    return Promise.resolve({ intent, created: true });
  }

  findIntent(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<BillingIntentSnapshot | null> {
    return Promise.resolve(
      this.intents.find(
        (intent) =>
          intent.subscriptionId === subscriptionId &&
          intent.billingCycle === billingCycle,
      ) ?? null,
    );
  }
}

class FakeExecutor {
  executions: string[] = [];

  constructor(private readonly repository: FakeRepository) {}

  execute(billingIntentId: string): Promise<unknown> {
    this.executions.push(billingIntentId);
    const intent = this.repository.intents.find(
      (candidate) => candidate.id === billingIntentId,
    );
    if (!intent) {
      return Promise.resolve({
        outcome: 'NOT_STARTED',
        billingIntentId,
        reason: 'NOT_FOUND',
      });
    }
    if (intent.status !== 'SCHEDULED') {
      return Promise.resolve({
        outcome: 'NOT_STARTED',
        billingIntentId,
        reason: 'NOT_SCHEDULED',
      });
    }
    intent.status = 'SUCCEEDED';
    intent.settledAt = new Date('2026-09-10T12:00:00.000Z');
    return Promise.resolve({
      outcome: 'SUCCEEDED',
      billingIntentId,
      attemptId: 'att-1',
      attemptNo: 1,
      providerOperationId: 'po-1',
      chargeOutcome: 'SUCCEEDED',
    });
  }
}

function buildContext(key = 'op-1'): IdempotencyOperationContext {
  return {
    key,
    payloadHash: 'hash',
    acquired: true,
    generation: 1,
    billingIntentRef: null,
    replay: null,
  };
}

describe('BillingCycleChargeService', () => {
  const subscription: BillingCycleSubscriptionSnapshot = {
    id: 'sub-1',
    amount: 100,
    currency: 'USD',
    status: 'ACTIVE',
  };

  it('creates the intent for a new cycle and settles it synchronously', async () => {
    const repository = new FakeRepository([subscription]);
    const executor = new FakeExecutor(repository);
    const service = new BillingCycleChargeService(
      repository,
      executor as never,
    );
    const context = buildContext();

    const result = await service.charge(
      { id: 'sub-1', cycle: '2026-09-10' },
      context,
    );

    expect(result).toMatchObject({
      subscriptionId: 'sub-1',
      billingCycle: '2026-09-10',
      scheduleDate: '2026-09-10',
      amount: 100,
      currency: 'USD',
      status: 'SUCCEEDED',
      omittedReason: null,
      created: true,
    });
    expect(typeof result.settledAt).toBe('string');
    expect(executor.executions).toEqual([result.id]);
    expect(context.billingIntentRef).toBe(result.id);
  });

  it('reuses the existing intent and never charges it again', async () => {
    const repository = new FakeRepository([subscription]);
    const existing = snapshotFor('sub-1', '2026-09-10');
    existing.status = 'SUCCEEDED';
    existing.settledAt = new Date('2026-09-10T12:00:00.000Z');
    repository.intents.push(existing);
    const executor = new FakeExecutor(repository);
    const service = new BillingCycleChargeService(
      repository,
      executor as never,
    );

    const result = await service.charge(
      { id: 'sub-1', cycle: '2026-09-10' },
      buildContext('op-2'),
    );

    expect(result.created).toBe(false);
    expect(result.id).toBe(existing.id);
    expect(result.status).toBe('SUCCEEDED');
    expect(executor.executions).toEqual([existing.id]);
  });

  it('throws 404 when the subscription does not exist', async () => {
    const repository = new FakeRepository([]);
    const service = new BillingCycleChargeService(
      repository,
      new FakeExecutor(repository) as never,
    );

    await expect(
      service.charge({ id: 'missing', cycle: '2026-09-10' }, buildContext()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 INVALID_TRANSITION for a non-ACTIVE subscription without an intent', async () => {
    const paused: BillingCycleSubscriptionSnapshot = {
      ...subscription,
      status: 'PAUSED',
    };
    const repository = new FakeRepository([paused]);
    const service = new BillingCycleChargeService(
      repository,
      new FakeExecutor(repository) as never,
    );

    const promise = service.charge(
      { id: 'sub-1', cycle: '2026-09-10' },
      buildContext(),
    );

    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await promise.catch((error: ConflictException) => {
      expect(error.getResponse()).toMatchObject({
        error: 'INVALID_TRANSITION',
      });
    });
  });

  it('returns the existing intent for a non-ACTIVE subscription that already has one', async () => {
    const paused: BillingCycleSubscriptionSnapshot = {
      ...subscription,
      status: 'PAUSED',
    };
    const repository = new FakeRepository([paused]);
    const existing = snapshotFor('sub-1', '2026-09-10');
    existing.status = 'SUCCEEDED';
    repository.intents.push(existing);
    const executor = new FakeExecutor(repository);
    const service = new BillingCycleChargeService(
      repository,
      executor as never,
    );

    const result = await service.charge(
      { id: 'sub-1', cycle: '2026-09-10' },
      buildContext('op-3'),
    );

    expect(result).toMatchObject({
      id: existing.id,
      created: false,
      status: 'SUCCEEDED',
    });
  });
});
