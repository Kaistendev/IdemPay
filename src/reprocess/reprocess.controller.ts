import {
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { billingCycleChargeParamsSchema } from '../billing-cycles/billing-cycle.schema';
import type { BillingCycleChargeParams } from '../billing-cycles/billing-cycle.types';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { IdempotencyContext } from '../idempotency/idempotency.context';
import type { IdempotencyOperationContext } from '../idempotency/idempotency.context';
import { IdempotencyGuard } from '../idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../idempotency/idempotency.interceptor';
import { ReprocessService } from './reprocess.service';
import type { ReprocessIntentView } from './reprocess.types';

@Controller('subscriptions')
export class ReprocessController {
  constructor(private readonly reprocess: ReprocessService) {}

  @Post(':id/billing-cycles/:cycle/reprocess')
  @HttpCode(200)
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  async execute(
    @Param(new ZodValidationPipe(billingCycleChargeParamsSchema))
    params: BillingCycleChargeParams,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): Promise<ReprocessIntentView> {
    const result = await this.reprocess.reprocess(params.id, params.cycle);
    context.billingIntentRef = result.id;
    return result;
  }
}
