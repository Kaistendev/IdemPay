import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { PAYMENT_GATEWAY } from '../gateway/gateway.constants';
import type { IPaymentGateway } from '../gateway/gateway.types';
import { errorTypeForOutcome } from '../gateway/payment-error';
import { TransitionsService } from '../transitions/transitions.service';
import { REPROCESS_REPOSITORY } from './reprocess.constants';
import type {
  ReprocessCandidate,
  ReprocessIntentView,
  ReprocessPort,
  ReprocessProbeResult,
} from './reprocess.types';

@Injectable()
export class ReprocessService {
  constructor(
    @Inject(REPROCESS_REPOSITORY) private readonly repository: ReprocessPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    private readonly transitions: TransitionsService,
  ) {}

  async probe(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessProbeResult> {
    const candidate = await this.loadCandidateOrThrow(
      subscriptionId,
      billingCycle,
    );
    return this.evaluate(candidate);
  }

  async reprocess(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessIntentView> {
    const candidate = await this.loadCandidateOrThrow(
      subscriptionId,
      billingCycle,
    );
    const probe = await this.evaluate(candidate);

    if (probe.outcome === 'NOT_ELIGIBLE') {
      throw new ConflictException({
        error: ErrorCode.ReprocessNotEligible,
        message: 'Billing intent is not eligible for reprocess',
        reason: probe.reason,
      });
    }

    if (probe.outcome === 'CLOSED_AS_SUCCEEDED') {
      return this.requireIntent(subscriptionId, billingCycle);
    }

    this.transitions.assertTransition(
      'billingIntent',
      candidate.status,
      'IN_FLIGHT',
    );
    const started = await this.repository.startManualAttempt(
      probe.billingIntentId,
    );

    if (started.outcome !== 'STARTED') {
      return this.requireIntent(subscriptionId, billingCycle);
    }

    const charge = await this.gateway.charge({
      providerOperationId: started.providerOperationId,
      amount: started.amount,
      currency: started.currency,
    });
    const verification = await this.gateway.verify(started.providerOperationId);

    if (verification === 'SUCCEEDED') {
      this.transitions.assertTransition(
        'billingIntent',
        'IN_FLIGHT',
        'SUCCEEDED',
      );
      await this.repository.settleManualAttempt(
        started.billingIntentId,
        started.attemptId,
        {
          outcome: 'SUCCEEDED',
        },
      );
    } else if (verification === 'FAILED') {
      const errorType = errorTypeForOutcome(charge.outcome);
      if (errorType !== null) {
        this.transitions.assertTransition(
          'billingIntent',
          'IN_FLIGHT',
          'FAILED_FINAL',
        );
        await this.repository.settleManualAttempt(
          started.billingIntentId,
          started.attemptId,
          {
            outcome: 'FAILED_FINAL',
            errorType,
          },
        );
      } else {
        await this.settleUnknown(probe.billingIntentId, started);
      }
    } else {
      await this.settleUnknown(probe.billingIntentId, started);
    }

    return this.requireIntent(subscriptionId, billingCycle);
  }

  private async evaluate(
    candidate: ReprocessCandidate,
  ): Promise<ReprocessProbeResult> {
    if (candidate.status === 'FAILED_FINAL') {
      return { outcome: 'ELIGIBLE', billingIntentId: candidate.id };
    }

    if (candidate.status === 'UNKNOWN') {
      if (candidate.providerOperationId === null) {
        return {
          outcome: 'NOT_ELIGIBLE',
          billingIntentId: candidate.id,
          reason: 'UNKNOWN_UNVERIFIABLE',
        };
      }

      const verification = await this.gateway.verify(
        candidate.providerOperationId,
      );

      if (verification === 'UNKNOWN') {
        return {
          outcome: 'NOT_ELIGIBLE',
          billingIntentId: candidate.id,
          reason: 'UNKNOWN_UNVERIFIABLE',
        };
      }

      if (verification === 'SUCCEEDED') {
        this.transitions.assertTransition(
          'billingIntent',
          'UNKNOWN',
          'SUCCEEDED',
        );
        await this.repository.closeVerificationAsSucceeded(candidate.id);
        return {
          outcome: 'CLOSED_AS_SUCCEEDED',
          billingIntentId: candidate.id,
        };
      }

      return { outcome: 'ELIGIBLE', billingIntentId: candidate.id };
    }

    return {
      outcome: 'NOT_ELIGIBLE',
      billingIntentId: candidate.id,
      reason:
        candidate.status === 'SUCCEEDED'
          ? 'ALREADY_SUCCEEDED'
          : 'NOT_ELIGIBLE_STATUS',
    };
  }

  private async settleUnknown(
    billingIntentId: string,
    started: { attemptId: string },
  ): Promise<void> {
    this.transitions.assertTransition('billingIntent', 'IN_FLIGHT', 'UNKNOWN');
    await this.repository.settleManualAttempt(
      billingIntentId,
      started.attemptId,
      {
        outcome: 'UNKNOWN',
      },
    );
  }

  private async loadCandidateOrThrow(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessCandidate> {
    const candidate = await this.repository.loadCandidate(
      subscriptionId,
      billingCycle,
    );

    if (candidate === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Billing intent not found for the given cycle',
      });
    }

    return candidate;
  }

  private async requireIntent(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessIntentView> {
    const view = await this.repository.findIntent(subscriptionId, billingCycle);

    if (view === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Billing intent not found for the given cycle',
      });
    }

    return view;
  }
}
