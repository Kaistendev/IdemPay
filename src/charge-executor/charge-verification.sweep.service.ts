import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Clock } from '../common/time/clock';
import { CLOCK } from '../common/time/clock';
import { PAYMENT_GATEWAY } from '../gateway/gateway.constants';
import type { IPaymentGateway } from '../gateway/gateway.types';
import { DEFAULT_BACKOFF_CONFIG, nextBackoffAttemptAt } from '../retry/backoff';
import { RETRY_RAND } from '../retry/retry.constants';
import { TransitionsService } from '../transitions/transitions.service';
import {
  DEFAULT_MANUAL_REVIEW_THRESHOLD,
  DEFAULT_VERIFY_CADENCE_CONFIG,
  MANUAL_REVIEW_WINDOW_MS,
  nextVerificationAt,
} from './charge-verification.cadence';
import { CHARGE_VERIFIER } from './charge-executor.constants';
import { VERIFICATION_SWEEP_INTERVAL } from './charge-verification.interval';
import type {
  ChargeVerifierPort,
  OmittedReason,
  UnknownChargeCandidate,
} from './charge-verification.types';

@Injectable()
export class ChargeVerificationSweepService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(CHARGE_VERIFIER) private readonly verifier: ChargeVerifierPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RETRY_RAND) private readonly rand: () => number,
    private readonly transitions: TransitionsService,
    @Inject(VERIFICATION_SWEEP_INTERVAL) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.verifyUnknown();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async verifyUnknown(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const now = this.clock.now();
      const candidates = await this.verifier.findUnknown(now);

      let processed = 0;
      for (const candidate of candidates) {
        await this.resolveCandidate(candidate, now);
        processed += 1;
      }
      return processed;
    } catch {
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async resolveCandidate(
    candidate: UnknownChargeCandidate,
    now: Date,
  ): Promise<void> {
    if (
      now.getTime() - candidate.unknownSince.getTime() >=
      MANUAL_REVIEW_WINDOW_MS
    ) {
      await this.verifier.markManualReview(candidate.billingIntentId);
      return;
    }

    const verification = await this.gateway.verify(
      candidate.providerOperationId,
    );

    if (verification === 'UNKNOWN') {
      const nextVerifyNumber = candidate.verifyCount + 1;
      const needsManualReview =
        nextVerifyNumber >= DEFAULT_MANUAL_REVIEW_THRESHOLD;
      await this.verifier.markVerificationUnknown(candidate.billingIntentId, {
        nextVerifyAt: needsManualReview
          ? null
          : nextVerificationAt(
              now,
              nextVerifyNumber,
              DEFAULT_VERIFY_CADENCE_CONFIG,
              this.rand,
            ),
        needsManualReview,
      });
      return;
    }

    if (verification === 'SUCCEEDED') {
      this.transitions.assertTransition(
        'billingIntent',
        'UNKNOWN',
        'SUCCEEDED',
      );
      await this.verifier.settleVerification(candidate.billingIntentId, {
        outcome: 'SUCCEEDED',
      });
      return;
    }

    if (candidate.subscriptionStatus === 'ACTIVE') {
      this.transitions.assertTransition(
        'billingIntent',
        'UNKNOWN',
        'RETRY_PENDING',
      );
      const nextAttemptAt = nextBackoffAttemptAt(
        now,
        candidate.attemptNo - 1,
        DEFAULT_BACKOFF_CONFIG,
        this.rand,
      );
      await this.verifier.settleVerification(candidate.billingIntentId, {
        outcome: 'RETRY_PENDING',
        nextAttemptAt,
      });
      return;
    }

    this.transitions.assertTransition('billingIntent', 'UNKNOWN', 'OMITTED');
    const omittedReason: OmittedReason =
      candidate.subscriptionStatus === 'PAUSED'
        ? 'SUBSCRIPTION_PAUSED'
        : 'SUBSCRIPTION_CANCELLED';
    await this.verifier.settleVerification(candidate.billingIntentId, {
      outcome: 'OMITTED',
      omittedReason,
    });
  }
}
