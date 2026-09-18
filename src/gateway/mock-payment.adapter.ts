import { Inject, Injectable } from '@nestjs/common';
import { PAYMENT_SCENARIO } from './payment-scenario';
import type {
  ChargeOutcome,
  ChargeRequest,
  ChargeResult,
  IPaymentGateway,
  PaymentScenario,
  VerificationResult,
} from './gateway.types';

const SCENARIO_OUTCOMES: Record<PaymentScenario, ChargeOutcome> = {
  SUCCESS: 'SUCCEEDED',
  DECLINED: 'DECLINED',
  TIMEOUT: 'TIMEOUT',
  AMBIGUOUS: 'AMBIGUOUS',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
};

function toVerification(
  outcome: ChargeOutcome | undefined,
): VerificationResult {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'DECLINED':
    case 'PROVIDER_ERROR':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

@Injectable()
export class MockPaymentAdapter implements IPaymentGateway {
  private readonly operations = new Map<string, ChargeOutcome>();
  private executions = 0;

  constructor(
    @Inject(PAYMENT_SCENARIO) private readonly scenario: PaymentScenario,
  ) {}

  charge(request: ChargeRequest): Promise<ChargeResult> {
    const recorded = this.operations.get(request.providerOperationId);
    if (recorded !== undefined) {
      return Promise.resolve({
        providerOperationId: request.providerOperationId,
        outcome: recorded,
      });
    }

    const outcome = SCENARIO_OUTCOMES[this.scenario];
    this.operations.set(request.providerOperationId, outcome);
    this.executions += 1;

    return Promise.resolve({
      providerOperationId: request.providerOperationId,
      outcome,
    });
  }

  verify(providerOperationId: string): Promise<VerificationResult> {
    return Promise.resolve(
      toVerification(this.operations.get(providerOperationId)),
    );
  }

  executedChargeCount(): number {
    return this.executions;
  }
}
