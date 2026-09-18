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

const serviceFor = (
  start: AttemptStartResult,
  outcome: ChargeOutcome,
  verification: VerificationResult,
) => {
  const executor = new FakeExecutor(start);
  const gateway = new FakeGateway(outcome, verification);
  return {
    service: new ChargeExecutorService(executor, gateway),
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

  it('settles FAILED with the classified error of a declined charge', async () => {
    const { service, executor } = serviceFor(STARTED, 'DECLINED', 'FAILED');

    const result = await service.execute(INTENT);

    expect(result).toMatchObject({ outcome: 'FAILED', errorType: 'DECLINED' });
    expect(executor.settlements).toEqual([
      { outcome: 'FAILED', errorType: 'DECLINED' },
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
