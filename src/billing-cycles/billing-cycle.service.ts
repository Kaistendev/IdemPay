import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChargeExecutorService } from '../charge-executor/charge-executor.service';
import { ErrorCode } from '../common/errors/error-code';
import type { IdempotencyOperationContext } from '../idempotency/idempotency.context';
import { BILLING_CYCLE_REPOSITORY } from './billing-cycle.constants';
import type {
  BillingCycleChargeParams,
  BillingCycleChargeResponse,
  BillingCycleRepositoryPort,
} from './billing-cycle.types';

@Injectable()
export class BillingCycleChargeService {
  constructor(
    @Inject(BILLING_CYCLE_REPOSITORY)
    private readonly repository: BillingCycleRepositoryPort,
    private readonly executor: ChargeExecutorService,
  ) {}

  async charge(
    params: BillingCycleChargeParams,
    context: IdempotencyOperationContext,
  ): Promise<BillingCycleChargeResponse> {
    const subscription = await this.repository.findSubscription(params.id);
    if (!subscription) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    const result = await this.repository.getOrCreateIntent({
      subscription,
      billingCycle: params.cycle,
      idempotencyKey: context.key,
    });

    if ('reason' in result) {
      throw new ConflictException({
        error: ErrorCode.InvalidTransition,
        message: `Subscription is ${subscription.status}; a new billing cycle cannot be charged`,
      });
    }

    const { intent, created } = result;

    await this.executor.execute(intent.id);

    const current = await this.repository.findIntent(params.id, params.cycle);
    if (!current) {
      throw new Error('Billing intent disappeared after charge execution');
    }

    context.billingIntentRef = current.id;

    return {
      id: current.id,
      subscriptionId: current.subscriptionId,
      billingCycle: current.billingCycle,
      scheduleDate: current.scheduleDate,
      amount: current.amount,
      currency: current.currency,
      status: current.status,
      omittedReason: current.omittedReason,
      settledAt: current.settledAt ? current.settledAt.toISOString() : null,
      created,
    };
  }
}
