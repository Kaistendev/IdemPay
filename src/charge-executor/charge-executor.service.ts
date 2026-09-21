import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../common/time/clock';
import { CLOCK, SystemClock } from '../common/time/clock';
import { PAYMENT_GATEWAY } from '../gateway/gateway.constants';
import type { IPaymentGateway } from '../gateway/gateway.types';
import { errorTypeForOutcome } from '../gateway/payment-error';
import { DEFAULT_BACKOFF_CONFIG, nextBackoffAttemptAt } from '../retry/backoff';
import { RETRY_RAND } from '../retry/retry.constants';
import { decideRetry } from '../retry/retry-policy';
import { CHARGE_EXECUTOR } from './charge-executor.constants';
import type {
  ChargeExecutionResult,
  ChargeExecutorPort,
} from './charge-executor.types';

@Injectable()
export class ChargeExecutorService {
  constructor(
    @Inject(CHARGE_EXECUTOR) private readonly executor: ChargeExecutorPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock = new SystemClock(),
    @Inject(RETRY_RAND) private readonly rand: () => number = Math.random,
  ) {}

  async execute(billingIntentId: string): Promise<ChargeExecutionResult> {
    const started = await this.executor.startAttempt(billingIntentId);

    if (started.outcome !== 'STARTED') {
      return {
        outcome: 'NOT_STARTED',
        billingIntentId,
        reason: started.outcome,
      };
    }

    const { attemptId, attemptNo, providerOperationId, amount, currency } =
      started;
    const charge = await this.gateway.charge({
      providerOperationId,
      amount,
      currency,
    });
    const verification = await this.gateway.verify(providerOperationId);
    const identity = {
      billingIntentId,
      attemptId,
      attemptNo,
      providerOperationId,
      chargeOutcome: charge.outcome,
    };

    if (verification === 'SUCCEEDED') {
      await this.executor.settleAttempt(billingIntentId, attemptId, {
        outcome: 'SUCCEEDED',
      });
      return { outcome: 'SUCCEEDED', ...identity };
    }

    const errorType =
      verification === 'FAILED' ? errorTypeForOutcome(charge.outcome) : null;

    if (errorType !== null) {
      if (decideRetry(errorType, attemptNo) === 'RETRY_PENDING') {
        const nextAttemptAt = nextBackoffAttemptAt(
          this.clock.now(),
          attemptNo - 1,
          DEFAULT_BACKOFF_CONFIG,
          this.rand,
        );
        await this.executor.settleAttempt(billingIntentId, attemptId, {
          outcome: 'RETRY_PENDING',
          errorType,
          nextAttemptAt,
        });
        return {
          outcome: 'RETRY_PENDING',
          nextAttemptAt,
          errorType,
          ...identity,
        };
      }

      await this.executor.settleAttempt(billingIntentId, attemptId, {
        outcome: 'FAILED_FINAL',
        errorType,
      });
      return { outcome: 'FAILED_FINAL', errorType, ...identity };
    }

    await this.executor.settleAttempt(billingIntentId, attemptId, {
      outcome: 'UNKNOWN',
    });
    return { outcome: 'UNKNOWN', ...identity };
  }
}
