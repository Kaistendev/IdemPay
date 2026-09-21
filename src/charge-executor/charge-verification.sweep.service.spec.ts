import type { Clock } from '../common/time/clock';
import type {
  ChargeResult,
  ChargeRequest,
  IPaymentGateway,
  VerificationResult,
} from '../gateway/gateway.types';
import { TransitionsService } from '../transitions/transitions.service';
import { ChargeVerificationSweepService } from './charge-verification.sweep.service';
import type {
  ChargeVerifierPort,
  UnknownChargeCandidate,
  VerificationResolution,
  VerificationSettlement,
} from './charge-verification.types';

const INTENT_A = '11111111-1111-1111-1111-111111111111';
const INTENT_B = '22222222-2222-2222-2222-222222222222';
const FIXED_NOW = new Date('2026-01-01T00:00:00Z');
const INTERVAL_MS = 10_000;

class FakeVerifier implements ChargeVerifierPort {
  readonly settlements: Array<{
    billingIntentId: string;
    settlement: VerificationSettlement;
  }> = [];
  readonly unknownMarks: Array<{
    billingIntentId: string;
    resolution: VerificationResolution;
  }> = [];
  readonly manualReviews: string[] = [];
  lastCutoff: Date | null = null;

  constructor(private readonly candidates: UnknownChargeCandidate[] = []) {}

  findUnknown(cutoff: Date): Promise<UnknownChargeCandidate[]> {
    this.lastCutoff = cutoff;
    return Promise.resolve(this.candidates);
  }

  settleVerification(
    billingIntentId: string,
    settlement: VerificationSettlement,
  ): Promise<void> {
    this.settlements.push({ billingIntentId, settlement });
    return Promise.resolve();
  }

  markVerificationUnknown(
    billingIntentId: string,
    resolution: VerificationResolution,
  ): Promise<void> {
    this.unknownMarks.push({ billingIntentId, resolution });
    return Promise.resolve();
  }

  markManualReview(billingIntentId: string): Promise<void> {
    this.manualReviews.push(billingIntentId);
    return Promise.resolve();
  }
}

class FakeGateway implements IPaymentGateway {
  charges = 0;
  verifications = 0;

  constructor(private readonly verification: VerificationResult) {}

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.charges += 1;
    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome: 'SUCCEEDED',
    });
  }

  verify(): Promise<VerificationResult> {
    this.verifications += 1;
    return Promise.resolve(this.verification);
  }
}

const candidateOf = (
  overrides: Partial<UnknownChargeCandidate>,
): UnknownChargeCandidate => ({
  billingIntentId: INTENT_A,
  providerOperationId: `${INTENT_A}:1`,
  attemptNo: 1,
  subscriptionStatus: 'ACTIVE',
  verifyCount: 0,
  unknownSince: new Date(FIXED_NOW.getTime() - 60_000),
  ...overrides,
});

const clock: Clock = { now: () => FIXED_NOW };

const sweepFor = (
  candidates: UnknownChargeCandidate[],
  verification: VerificationResult,
) => {
  const verifier = new FakeVerifier(candidates);
  const gateway = new FakeGateway(verification);
  const service = new ChargeVerificationSweepService(
    verifier,
    gateway,
    clock,
    () => 0.5,
    new TransitionsService(),
    INTERVAL_MS,
  );
  return { service, verifier, gateway };
};

describe('ChargeVerificationSweepService', () => {
  it('queries only the candidates due for verification at the current time', async () => {
    const { service, verifier } = sweepFor([], 'UNKNOWN');

    await service.verifyUnknown();

    expect(verifier.lastCutoff).toEqual(FIXED_NOW);
  });

  it('keeps an intent UNKNOWN and schedules the cadence while verify stays unknown', async () => {
    const { service, verifier, gateway } = sweepFor(
      [candidateOf({}), candidateOf({ billingIntentId: INTENT_B })],
      'UNKNOWN',
    );

    const processed = await service.verifyUnknown();

    expect(processed).toBe(2);
    expect(gateway.verifications).toBe(2);
    expect(gateway.charges).toBe(0);
    expect(verifier.unknownMarks).toEqual([
      {
        billingIntentId: INTENT_A,
        resolution: {
          nextVerifyAt: new Date('2026-01-01T00:01:00Z'),
          needsManualReview: false,
        },
      },
      {
        billingIntentId: INTENT_B,
        resolution: {
          nextVerifyAt: new Date('2026-01-01T00:01:00Z'),
          needsManualReview: false,
        },
      },
    ]);
    expect(verifier.settlements).toEqual([]);
    expect(verifier.manualReviews).toEqual([]);
  });

  it('grows the verification window with each failed verification', async () => {
    const { service, verifier } = sweepFor(
      [candidateOf({ verifyCount: 2 })],
      'UNKNOWN',
    );

    await service.verifyUnknown();

    expect(verifier.unknownMarks).toEqual([
      {
        billingIntentId: INTENT_A,
        resolution: {
          nextVerifyAt: new Date('2026-01-01T00:04:00Z'),
          needsManualReview: false,
        },
      },
    ]);
  });

  it('marks the intent for manual review on the tenth verification', async () => {
    const { service, verifier, gateway } = sweepFor(
      [candidateOf({ verifyCount: 9 })],
      'UNKNOWN',
    );

    await service.verifyUnknown();

    expect(gateway.verifications).toBe(1);
    expect(verifier.unknownMarks).toEqual([
      {
        billingIntentId: INTENT_A,
        resolution: { nextVerifyAt: null, needsManualReview: true },
      },
    ]);
  });

  it('does not verify an intent whose unknown state exceeds twenty-four hours', async () => {
    const { service, verifier, gateway } = sweepFor(
      [
        candidateOf({
          unknownSince: new Date(FIXED_NOW.getTime() - 25 * 3_600_000),
        }),
      ],
      'UNKNOWN',
    );

    const processed = await service.verifyUnknown();

    expect(processed).toBe(1);
    expect(gateway.verifications).toBe(0);
    expect(gateway.charges).toBe(0);
    expect(verifier.manualReviews).toEqual([INTENT_A]);
    expect(verifier.unknownMarks).toEqual([]);
  });

  it('still verifies intents whose unknown state is younger than twenty-four hours', async () => {
    const { service, verifier, gateway } = sweepFor(
      [candidateOf({})],
      'UNKNOWN',
    );

    await service.verifyUnknown();

    expect(gateway.verifications).toBe(1);
    expect(verifier.manualReviews).toEqual([]);
    expect(verifier.unknownMarks).toHaveLength(1);
  });

  it('closes the intent as SUCCEEDED when verify confirms the charge', async () => {
    const { service, verifier, gateway } = sweepFor(
      [candidateOf({})],
      'SUCCEEDED',
    );

    await service.verifyUnknown();

    expect(gateway.verifications).toBe(1);
    expect(gateway.charges).toBe(0);
    expect(verifier.settlements).toEqual([
      { billingIntentId: INTENT_A, settlement: { outcome: 'SUCCEEDED' } },
    ]);
    expect(verifier.unknownMarks).toEqual([]);
    expect(verifier.manualReviews).toEqual([]);
  });

  it('reschedules a retry for an ACTIVE subscription when verify reports FAILED', async () => {
    const { service, verifier, gateway } = sweepFor(
      [candidateOf({})],
      'FAILED',
    );

    await service.verifyUnknown();

    expect(gateway.charges).toBe(0);
    expect(verifier.settlements).toEqual([
      {
        billingIntentId: INTENT_A,
        settlement: {
          outcome: 'RETRY_PENDING',
          nextAttemptAt: new Date('2026-01-01T00:00:10Z'),
        },
      },
    ]);
    expect(verifier.unknownMarks).toEqual([]);
  });

  it('uses the failed attempt index for the retry backoff window', async () => {
    const { service, verifier } = sweepFor(
      [candidateOf({ attemptNo: 3 })],
      'FAILED',
    );

    await service.verifyUnknown();

    expect(verifier.settlements[0]).toEqual({
      billingIntentId: INTENT_A,
      settlement: {
        outcome: 'RETRY_PENDING',
        nextAttemptAt: new Date('2026-01-01T00:00:40Z'),
      },
    });
  });

  it('marks the intent OMITTED with SUBSCRIPTION_PAUSED when the subscription is paused', async () => {
    const { service, verifier } = sweepFor(
      [candidateOf({ subscriptionStatus: 'PAUSED' })],
      'FAILED',
    );

    await service.verifyUnknown();

    expect(verifier.settlements).toEqual([
      {
        billingIntentId: INTENT_A,
        settlement: {
          outcome: 'OMITTED',
          omittedReason: 'SUBSCRIPTION_PAUSED',
        },
      },
    ]);
  });

  it('marks the intent OMITTED with SUBSCRIPTION_CANCELLED when the subscription is cancelled', async () => {
    const { service, verifier } = sweepFor(
      [candidateOf({ subscriptionStatus: 'CANCELLED' })],
      'FAILED',
    );

    await service.verifyUnknown();

    expect(verifier.settlements).toEqual([
      {
        billingIntentId: INTENT_A,
        settlement: {
          outcome: 'OMITTED',
          omittedReason: 'SUBSCRIPTION_CANCELLED',
        },
      },
    ]);
  });
});

describe('ChargeVerificationSweepService periodic behaviour', () => {
  class BlockingVerifier implements ChargeVerifierPort {
    calls = 0;
    private resolveCurrent: (() => void) | null = null;

    findUnknown(): Promise<UnknownChargeCandidate[]> {
      this.calls += 1;
      return new Promise((resolve) => {
        this.resolveCurrent = () => resolve([]);
      });
    }

    settleVerification(): Promise<void> {
      return Promise.resolve();
    }

    markVerificationUnknown(): Promise<void> {
      return Promise.resolve();
    }

    markManualReview(): Promise<void> {
      return Promise.resolve();
    }

    finishCurrent(): void {
      this.resolveCurrent?.();
      this.resolveCurrent = null;
    }
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the verification sweep on every configured interval tick', async () => {
    const verifier = new BlockingVerifier();
    const service = new ChargeVerificationSweepService(
      verifier,
      new FakeGateway('UNKNOWN'),
      clock,
      () => 0.5,
      new TransitionsService(),
      INTERVAL_MS,
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(verifier.calls).toBe(1);

    verifier.finishCurrent();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(verifier.calls).toBe(2);
  });

  it('stops sweeping after the service is destroyed', async () => {
    const verifier = new BlockingVerifier();
    const service = new ChargeVerificationSweepService(
      verifier,
      new FakeGateway('UNKNOWN'),
      clock,
      () => 0.5,
      new TransitionsService(),
      INTERVAL_MS,
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(verifier.calls).toBe(1);
  });

  it('never runs two overlapping verification sweeps', async () => {
    const verifier = new BlockingVerifier();
    const service = new ChargeVerificationSweepService(
      verifier,
      new FakeGateway('UNKNOWN'),
      clock,
      () => 0.5,
      new TransitionsService(),
      INTERVAL_MS,
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(verifier.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(verifier.calls).toBe(1);

    verifier.finishCurrent();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(verifier.calls).toBe(2);
  });
});
