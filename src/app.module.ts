import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BillingCyclesModule } from './billing-cycles/billing-cycles.module';
import { CalendarModule } from './calendar/calendar.module';
import { ChargeExecutorModule } from './charge-executor/charge-executor.module';
import { ChargesModule } from './charges/charges.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReprocessModule } from './reprocess/reprocess.module';
import { SchedulerModule } from './scheduler/billing-scheduler.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [
    CommonModule,
    HealthModule,
    DatabaseModule,
    IdempotencyModule,
    CalendarModule,
    ChargeExecutorModule,
    ChargesModule,
    SubscriptionsModule,
    BillingCyclesModule,
    SchedulerModule,
    NotificationsModule,
    ReprocessModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
