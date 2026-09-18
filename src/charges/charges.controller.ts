import {
  Body,
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { IdempotencyContext } from '../idempotency/idempotency.context';
import type { IdempotencyOperationContext } from '../idempotency/idempotency.context';
import { IdempotencyGuard } from '../idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../idempotency/idempotency.interceptor';
import { chargeSchema } from './charge.schema';
import type { ChargeRequest } from './charge.schema';
import { ChargesService } from './charges.service';
import type { ChargeResult } from './charges.types';

@Controller('charges')
export class ChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Post()
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  create(
    @Body(new ZodValidationPipe(chargeSchema)) body: ChargeRequest,
    @IdempotencyContext() context: IdempotencyOperationContext,
  ): ChargeResult {
    const result = this.charges.create(body);
    context.billingIntentRef = result.id;
    return result;
  }
}
