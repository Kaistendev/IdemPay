import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { IdempotencyGuard } from '../idempotency/idempotency.guard';
import { IdempotencySettlementInterceptor } from '../idempotency/idempotency.interceptor';
import {
  createSubscriptionSchema,
  subscriptionParamsSchema,
} from './subscription.schema';
import type {
  CreateSubscriptionRequest,
  SubscriptionParams,
} from './subscription.schema';
import { SubscriptionsQueryService } from './subscriptions.query.service';
import { SubscriptionLifecycleService } from './subscriptions.lifecycle.service';
import { SubscriptionsService } from './subscriptions.service';
import type {
  SubscriptionDetailResponse,
  SubscriptionResponse,
} from './subscriptions.types';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly queries: SubscriptionsQueryService,
    private readonly cancellations: SubscriptionLifecycleService,
  ) {}

  @Post()
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  create(
    @Body(new ZodValidationPipe(createSubscriptionSchema))
    body: CreateSubscriptionRequest,
  ): Promise<SubscriptionResponse> {
    return this.subscriptions.create(body);
  }

  @Get(':id')
  findOne(
    @Param(new ZodValidationPipe(subscriptionParamsSchema))
    params: SubscriptionParams,
  ): Promise<SubscriptionDetailResponse> {
    return this.queries.findById(params.id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(IdempotencyGuard)
  @UseInterceptors(IdempotencySettlementInterceptor)
  async cancel(
    @Param(new ZodValidationPipe(subscriptionParamsSchema))
    params: SubscriptionParams,
  ): Promise<SubscriptionDetailResponse> {
    await this.cancellations.cancel(params.id);
    return this.queries.findById(params.id);
  }
}
