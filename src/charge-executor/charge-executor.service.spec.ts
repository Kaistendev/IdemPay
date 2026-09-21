import type {
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  VerificationResult,
} from '../gateway/gateway.types';
import { ChargeExecutorService } from './charge-executor.service';
import type {
  AttemptSettlement,
  AttemptStartResult,
  ChargeExecutorPort,
} from './charge-executor.types';

const INTENT = '11111111-1111-1111-1111-111111111111';

const STARTED: AttemptStartResult = {
  outcome: 'STARTED',
  billingIntentId: INTENT,
  attemptId: 'attempt-1',
  attemptNo: 1,
  providerOperationId: `${INTENT}:1`,
  amount: 100,
  currency: 'USD',
};

class FakeExecutor implements ChargeExecutorPort {
  readonly settlements: AttemptSettlement[] = [];

  constructor(private readonly start: AttemptStartResult) {}

  startAttempt(): Promise<AttemptStartResult> {
    return Promise.resolve(this.start);
  }

  settleAttempt(
    _billingIntentId: string,
    _attemptId: string,
    settlement: AttemptSettlement,
  ): Promise<void> {
    this.settlements.push(settlement);
    return Promise.resolve();
  }
}

class FakeGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;

  constructor(
    private readonly outcome: ChargeOutcome,
    private readonly verification: VerificationResult,
  ) {}

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome: this.outcome,
    });
  }

  verify(): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve(this.verification);
  }
}

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

const serviceFor = (
  start: AttemptStartResult,
  outcome: ChargeOutcome,
  verification: VerificationResult,
  clock = { now: () => FIXED_NOW },
  rand = () => 0.5,
) => {
  const executor = new FakeExecutor(start);
  const gateway = new FakeGateway(outcome, verification);
  return {
    service: new ChargeExecutorService(executor, gateway, clock, rand),
    executor,
    gateway,
  };
};

describe('ChargeExecutorService', () => {
  it('settles SUCCEEDED only when the gateway confirms the charge', async () => {
    const { service, executor, gateway } = serviceFor(
      STARTED,
      'SUCCEEDED',
      'SUCCEEDED',
    );

    const result = await service.execute(INTENT);

    expect(result).toMatchObject({
      outcome: 'SUCCEEDED',
      billingIntentId: INTENT,
      attemptNo: 1,
      providerOperationId: `${INTENT}:1`,
    });
    expect(executor.settlements).toEqual([{ outcome: 'SUCCEEDED' }]);
    expect(gateway.charges).toBe(1);
    expect(gateway.verifications).toBe(1);
  });

  it('does not settle success when the local response is unconfirmed', async () => {
    const { service, executor } = serviceFor(STARTED, 'SUCCEEDED', 'UNKNOWN');

    const result = await service.execute(INTENT);

    expect(result.outcome).toBe('UNKNOWN');
    expect(executor.settlements).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  it('settles FAILED_FINAL for a declined charge without scheduling a retry', async () => {
    const { service, executor } = serviceFor(STARTED, 'DECLINED', 'FAILED');

    const result = await service.execute(INTENT);

    expect(result).toMatchObject({
      outcome: 'FAILED_FINAL',
      errorType: 'DECLINED',
    });
    expect(executor.settlements).toEqual([
      { outcome: 'FAILED_FINAL', errorType: 'DECLINED' },
    ]);
  });

  it('schedules a RETRY_PENDING with backoff for a retryable provider error', async () => {
    const { service, executor } = serviceFor(
      STARTED,
      'PROVIDER_ERROR',
      'FAILED',
    );

    const result = await service.execute(INTENT);

    expect(result).toMatchObject({
      outcome: 'RETRY_PENDING',
      errorType: 'PROVIDER_ERROR',
      attemptNo: 1,
    });
    expect(result).toEqual(
      expect.objectContaining({
        nextAttemptAt: new Date('2026-01-01T00:00:10Z'),
      }),
    );
    expect(executor.settlements).toEqual([
      {
        outcome: 'RETRY_PENDING',
        errorType: 'PROVIDER_ERROR',
        nextAttemptAt: new Date('2026-01-01T00:00:10Z'),
      },
    ]);
  });

  it('settles FAILED_FINAL on the fifth retryable failure', async () => {
    const { service, executor } = serviceFor(
      { ...STARTED, attemptNo: 5 },
      'PROVIDER_ERROR',
      'FAILED',
    );

    const result = await service.execute(INTENT);

    expect(result).toMatchObject({
      outcome: 'FAILED_FINAL',
      errorType: 'PROVIDER_ERROR',
      attemptNo: 5,
    });
    expect(executor.settlements).toEqual([
      { outcome: 'FAILED_FINAL', errorType: 'PROVIDER_ERROR' },
    ]);
  });

  it('settles UNKNOWN for a timeout that cannot be verified', async () => {
    const { service, executor } = serviceFor(STARTED, 'TIMEOUT', 'UNKNOWN');

    const result = await service.execute(INTENT);

    expect(result.outcome).toBe('UNKNOWN');
    expect(executor.settlements).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  it('does not call the gateway when the attempt cannot start', async () => {
    const { service, executor, gateway } = serviceFor(
      {
        outcome: 'NOT_SCHEDULED',
        billingIntentId: INTENT,
        status: 'SUCCEEDED',
      },
      'SUCCEEDED',
      'SUCCEEDED',
    );

    const result = await service.execute(INTENT);

    expect(result).toEqual({
      outcome: 'NOT_STARTED',
      billingIntentId: INTENT,
      reason: 'NOT_SCHEDULED',
    });
    expect(gateway.charges).toBe(0);
    expect(gateway.verifications).toBe(0);
    expect(executor.settlements).toEqual([]);
  });
});
