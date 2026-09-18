import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_GATEWAY } from '../gateway/gateway.constants';
import type { IPaymentGateway } from '../gateway/gateway.types';
import { errorTypeForOutcome } from '../gateway/payment-error';
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
      await this.executor.settleAttempt(billingIntentId, attemptId, {
        outcome: 'FAILED',
        errorType,
      });
      return { outcome: 'FAILED', errorType, ...identity };
    }

    await this.executor.settleAttempt(billingIntentId, attemptId, {
      outcome: 'UNKNOWN',
    });
    return { outcome: 'UNKNOWN', ...identity };
  }
}
