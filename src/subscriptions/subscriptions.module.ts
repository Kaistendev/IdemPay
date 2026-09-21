import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { HealthModule } from '../health/health.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { TransitionsModule } from '../transitions/transitions.module';
import { SubscriptionCancellationRepository } from './subscription-cancellation.repository';
import { SubscriptionQueriesRepository } from './subscription-queries.repository';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionLifecycleService } from './subscriptions.lifecycle.service';
import { SubscriptionsQueryService } from './subscriptions.query.service';
import {
  SUBSCRIPTIONS_REPOSITORY,
  SUBSCRIPTION_LIFECYCLE,
  SUBSCRIPTION_QUERIES,
} from './subscriptions.constants';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [CommonModule, HealthModule, IdempotencyModule, TransitionsModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    SubscriptionsQueryService,
    SubscriptionLifecycleService,
    SubscriptionQueriesRepository,
    SubscriptionCancellationRepository,
    { provide: SUBSCRIPTIONS_REPOSITORY, useClass: SubscriptionsRepository },
    {
      provide: SUBSCRIPTION_QUERIES,
      useExisting: SubscriptionQueriesRepository,
    },
    {
      provide: SUBSCRIPTION_LIFECYCLE,
      useExisting: SubscriptionCancellationRepository,
    },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
