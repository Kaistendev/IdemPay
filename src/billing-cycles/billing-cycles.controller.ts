import {
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { IdempotencyContext } from '../idempotency/idempotency.context';
import type { IdempotencyOperationContext } from '../idempotency/idempotency.context';
import { IdempotencyGuard } from '../idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../idempotency/idempotency.interceptor';
import { billingCycleChargeParamsSchema } from './billing-cycle.schema';
import { BillingCycleChargeService } from './billing-cycle.service';
import type {
  BillingCycleChargeParams,
  BillingCycleChargeResponse,
} from './billing-cycle.types';

@Controller('subscriptions')
export class BillingCyclesController {
  constructor(private readonly charges: BillingCycleChargeService) {}

  @Post(':id/billing-cycles/:cycle/charge')
  @HttpCode(200)
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  async charge(
    @Param(new ZodValidationPipe(billingCycleChargeParamsSchema))
    params: BillingCycleChargeParams,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): Promise<BillingCycleChargeResponse> {
    return this.charges.charge(params, context);
  }
}
