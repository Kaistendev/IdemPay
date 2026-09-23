// T53 — Reprocess: elegibilidad y verify previo: @RF-29 @INV-07
// T54 — Reprocess: ejecución y asentado: @RF-29 @INV-02
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TransitionsService } from '../transitions/transitions.service';
import { ReprocessService } from './reprocess.service';
import type {
  ReprocessCandidate,
  ReprocessIntentView,
  ReprocessPort,
  ReprocessProbeResult,
  ReprocessStartResult,
} from './reprocess.types';

const candidate = (
  overrides: Partial<ReprocessCandidate> = {},
): ReprocessCandidate => ({
  id: 'int-1',
  subscriptionId: 'sub-1',
  status: 'UNKNOWN',
  providerOperationId: 'op-1',
  ...overrides,
});

const viewFor = (
  base: ReprocessCandidate,
  status: ReprocessIntentView['status'],
): ReprocessIntentView => ({
  id: base.id,
  subscriptionId: base.subscriptionId,
  billingCycle: '2026-05-10',
  scheduleDate: '2026-05-10',
  amount: 100,
  currency: 'USD',
  status,
  omittedReason: null,
  settledAt: status === 'SUCCEEDED' ? new Date('2026-05-10T12:00:00Z') : null,
});

class FakeReprocessPort implements ReprocessPort {
  current: ReprocessCandidate | null;
  view: ReprocessIntentView | null;
  readonly closed: string[] = [];
  readonly manualAttempts: string[] = [];
  readonly settlements: Array<{
    billingIntentId: string;
    attemptId: string;
    outcome: string;
  }> = [];
  readonly loadCalls: Array<{ subscriptionId: string; billingCycle: string }> =
    [];
  startResult: ReprocessStartResult = {
    outcome: 'STARTED',
    billingIntentId: 'int-1',
    attemptId: 'att-m1',
    providerOperationId: 'op-m1',
    amount: 100,
    currency: 'USD',
  };

  constructor(current: ReprocessCandidate | null) {
    this.current = current;
    this.view = current ? viewFor(current, current.status) : null;
  }

  loadCandidate(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessCandidate | null> {
    this.loadCalls.push({ subscriptionId, billingCycle });
    return Promise.resolve(this.current);
  }

  closeVerificationAsSucceeded(billingIntentId: string): Promise<boolean> {
    this.closed.push(billingIntentId);
    this.view = this.view
      ? { ...this.view, status: 'SUCCEEDED', settledAt: new Date() }
      : null;
    return Promise.resolve(true);
  }

  startManualAttempt(billingIntentId: string): Promise<ReprocessStartResult> {
    this.manualAttempts.push(billingIntentId);
    return Promise.resolve(this.startResult);
  }

  settleManualAttempt(
    billingIntentId: string,
    attemptId: string,
    settlement: { outcome: string },
  ): Promise<void> {
    this.settlements.push({
      billingIntentId,
      attemptId,
      outcome: settlement.outcome,
    });
    this.view = this.view
      ? {
          ...this.view,
          status:
            settlement.outcome === 'FAILED_FINAL'
              ? 'FAILED_FINAL'
              : settlement.outcome,
          settledAt:
            settlement.outcome === 'SUCCEEDED' ||
            settlement.outcome === 'FAILED_FINAL'
              ? new Date()
              : null,
        }
      : null;
    return Promise.resolve();
  }

  findIntent(): Promise<ReprocessIntentView | null> {
    return Promise.resolve(this.view);
  }
}

const ProbeTitles: Array<[string, ReprocessProbeResult]> = [
  ['FAILED_FINAL', { outcome: 'ELIGIBLE', billingIntentId: 'int-1' }],
  [
    'SUCCEEDED',
    {
      outcome: 'NOT_ELIGIBLE',
      billingIntentId: 'int-1',
      reason: 'ALREADY_SUCCEEDED',
    },
  ],
  [
    'SCHEDULED',
    {
      outcome: 'NOT_ELIGIBLE',
      billingIntentId: 'int-1',
      reason: 'NOT_ELIGIBLE_STATUS',
    },
  ],
];

describe('ReprocessService', () => {
  let gateway: { charge: jest.Mock; verify: jest.Mock };
  const transitions = new TransitionsService();

  const serviceFor = (repository: ReprocessPort): ReprocessService =>
    new ReprocessService(repository, gateway, transitions);

  beforeEach(() => {
    gateway = {
      charge: jest.fn().mockResolvedValue({
        outcome: 'SUCCEEDED',
        providerOperationId: 'op-m1',
      }),
      verify: jest.fn().mockResolvedValue('FAILED' as const),
    };
  });

  describe('probe', () => {
    it('accepts an UNKNOWN intent whose last charge verify FAILED', async () => {
      const repository = new FakeReprocessPort(candidate());
      const service = serviceFor(repository);

      const result = await service.probe('sub-1', '2026-05-10');

      expect(result).toEqual({
        outcome: 'ELIGIBLE',
        billingIntentId: 'int-1',
      });
      expect(gateway.verify).toHaveBeenCalledTimes(1);
      expect(gateway.verify).toHaveBeenCalledWith('op-1');
      expect(repository.closed).toEqual([]);
      expect(repository.loadCalls).toEqual([
        { subscriptionId: 'sub-1', billingCycle: '2026-05-10' },
      ]);
    });

    it('accepts a FAILED_FINAL intent without verifying', async () => {
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      const service = serviceFor(repository);

      const result = await service.probe('sub-1', '2026-05-10');

      expect(result).toEqual({
        outcome: 'ELIGIBLE',
        billingIntentId: 'int-1',
      });
      expect(gateway.verify).not.toHaveBeenCalled();
    });

    it('rejects an UNKNOWN intent whose verify is still UNKNOWN without calling charge', async () => {
      gateway.verify.mockResolvedValueOnce('UNKNOWN');
      const repository = new FakeReprocessPort(candidate());
      const service = serviceFor(repository);

      const result = await service.probe('sub-1', '2026-05-10');

      expect(result).toEqual({
        outcome: 'NOT_ELIGIBLE',
        billingIntentId: 'int-1',
        reason: 'UNKNOWN_UNVERIFIABLE',
      });
      expect(gateway.verify).toHaveBeenCalledTimes(1);
      expect(repository.closed).toEqual([]);
    });

    it('rejects an UNKNOWN intent without a provider operation to verify', async () => {
      const repository = new FakeReprocessPort(
        candidate({ providerOperationId: null }),
      );
      const service = serviceFor(repository);

      const result = await service.probe('sub-1', '2026-05-10');

      expect(result).toEqual({
        outcome: 'NOT_ELIGIBLE',
        billingIntentId: 'int-1',
        reason: 'UNKNOWN_UNVERIFIABLE',
      });
      expect(gateway.verify).not.toHaveBeenCalled();
    });

    it('closes an UNKNOWN intent as SUCCEEDED when verify confirms the charge, without charging again', async () => {
      gateway.verify.mockResolvedValueOnce('SUCCEEDED');
      const repository = new FakeReprocessPort(candidate());
      const service = serviceFor(repository);

      const result = await service.probe('sub-1', '2026-05-10');

      expect(result).toEqual({
        outcome: 'CLOSED_AS_SUCCEEDED',
        billingIntentId: 'int-1',
      });
      expect(gateway.verify).toHaveBeenCalledWith('op-1');
      expect(repository.closed).toEqual(['int-1']);
    });

    it.each(ProbeTitles)(
      'rejects a %s intent without verifying',
      async (_status, expected) => {
        const repository = new FakeReprocessPort(
          candidate({ status: _status as ReprocessCandidate['status'] }),
        );
        const service = serviceFor(repository);

        const result = await service.probe('sub-1', '2026-05-10');

        expect(result).toEqual(expected);
        expect(gateway.verify).not.toHaveBeenCalled();
        expect(repository.closed).toEqual([]);
      },
    );

    it.each<ReprocessCandidate['status']>([
      'IN_FLIGHT',
      'RETRY_PENDING',
      'OMITTED',
    ])(
      'rejects a %s intent as not eligible without verifying',
      async (status) => {
        const repository = new FakeReprocessPort(candidate({ status }));
        const service = serviceFor(repository);

        const result = await service.probe('sub-1', '2026-05-10');

        expect(result).toEqual({
          outcome: 'NOT_ELIGIBLE',
          billingIntentId: 'int-1',
          reason: 'NOT_ELIGIBLE_STATUS',
        });
        expect(gateway.verify).not.toHaveBeenCalled();
      },
    );

    it('throws NOT_FOUND when no intent exists for the subscription cycle', async () => {
      const repository = new FakeReprocessPort(null);
      const service = serviceFor(repository);

      const error = await service
        .probe('sub-1', '2026-05-10')
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        error: 'NOT_FOUND',
      });
    });
  });

  describe('reprocess', () => {
    beforeEach(() => {
      gateway.verify.mockResolvedValue('SUCCEEDED');
    });

    it('executes a MANUAL attempt on a FAILED_FINAL intent and settles it as SUCCEEDED', async () => {
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('SUCCEEDED');
      expect(result.settledAt).not.toBeNull();
      expect(repository.manualAttempts).toEqual(['int-1']);
      expect(repository.settlements).toEqual([
        { billingIntentId: 'int-1', attemptId: 'att-m1', outcome: 'SUCCEEDED' },
      ]);
      expect(gateway.charge).toHaveBeenCalledTimes(1);
      expect(gateway.charge).toHaveBeenCalledWith({
        providerOperationId: 'op-m1',
        amount: 100,
        currency: 'USD',
      });
      expect(gateway.verify).toHaveBeenCalledWith('op-m1');
    });

    it('settles a declined MANUAL attempt as FAILED_FINAL', async () => {
      gateway.charge.mockResolvedValueOnce({
        outcome: 'DECLINED',
        providerOperationId: 'op-m1',
      });
      gateway.verify.mockResolvedValueOnce('FAILED');
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('FAILED_FINAL');
      expect(repository.settlements).toEqual([
        {
          billingIntentId: 'int-1',
          attemptId: 'att-m1',
          outcome: 'FAILED_FINAL',
        },
      ]);
    });

    it('settles an ambiguous MANUAL attempt as UNKNOWN', async () => {
      gateway.charge.mockResolvedValueOnce({
        outcome: 'TIMEOUT',
        providerOperationId: 'op-m1',
      });
      gateway.verify.mockResolvedValueOnce('UNKNOWN');
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('UNKNOWN');
      expect(result.settledAt).toBeNull();
      expect(repository.settlements).toEqual([
        { billingIntentId: 'int-1', attemptId: 'att-m1', outcome: 'UNKNOWN' },
      ]);
    });

    it('rejects an intent that is not eligible with REPROCESS_NOT_ELIGIBLE and never calls charge', async () => {
      const repository = new FakeReprocessPort(
        candidate({ status: 'SUCCEEDED' }),
      );
      const service = serviceFor(repository);

      const error = await service
        .reprocess('sub-1', '2026-05-10')
        .then(() => null)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        error: 'REPROCESS_NOT_ELIGIBLE',
        reason: 'ALREADY_SUCCEEDED',
      });
      expect(repository.manualAttempts).toEqual([]);
      expect(gateway.charge).not.toHaveBeenCalled();
      expect(repository.settlements).toEqual([]);
    });

    it('returns the current intent when the probe already closed it as SUCCEEDED', async () => {
      gateway.verify.mockResolvedValueOnce('SUCCEEDED');
      const repository = new FakeReprocessPort(candidate());
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('SUCCEEDED');
      expect(repository.closed).toEqual(['int-1']);
      expect(repository.manualAttempts).toEqual([]);
      expect(gateway.charge).not.toHaveBeenCalled();
      expect(repository.settlements).toEqual([]);
    });

    it('returns the current intent state without charging when the start is raced away', async () => {
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      repository.startResult = {
        outcome: 'NOT_ELIGIBLE',
        billingIntentId: 'int-1',
      };
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('FAILED_FINAL');
      expect(repository.manualAttempts).toEqual(['int-1']);
      expect(gateway.charge).not.toHaveBeenCalled();
      expect(repository.settlements).toEqual([]);
    });

    it('returns the current intent state without charging when another attempt is IN_FLIGHT', async () => {
      const repository = new FakeReprocessPort(
        candidate({ status: 'FAILED_FINAL' }),
      );
      repository.startResult = {
        outcome: 'ALREADY_IN_FLIGHT',
        billingIntentId: 'int-1',
      };
      const service = serviceFor(repository);

      const result = await service.reprocess('sub-1', '2026-05-10');

      expect(result.status).toBe('FAILED_FINAL');
      expect(gateway.charge).not.toHaveBeenCalled();
      expect(repository.settlements).toEqual([]);
    });
  });
});
