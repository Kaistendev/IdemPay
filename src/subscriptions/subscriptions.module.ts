import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { HealthModule } from '../health/health.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { SubscriptionCancellationRepository } from './subscription-cancellation.repository';
import { SubscriptionQueriesRepository } from './subscription-queries.repository';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsCancellationService } from './subscriptions.cancellation.service';
import { SubscriptionsQueryService } from './subscriptions.query.service';
import {
  SUBSCRIPTIONS_REPOSITORY,
  SUBSCRIPTION_CANCELLATION,
  SUBSCRIPTION_QUERIES,
} from './subscriptions.constants';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [CommonModule, HealthModule, IdempotencyModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionsQueryService,
    SubscriptionsCancellationService,
    SubscriptionQueriesRepository,
    SubscriptionCancellationRepository,
    { provide: SUBSCRIPTIONS_REPOSITORY, useClass: SubscriptionsRepository },
    {
      provide: SUBSCRIPTION_QUERIES,
      useExisting: SubscriptionQueriesRepository,
    },
    {
      provide: SUBSCRIPTION_CANCELLATION,
      useExisting: SubscriptionCancellationRepository,
    },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
