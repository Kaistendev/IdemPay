import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { HealthModule } from '../health/health.module';
import {
  ENGINE_DOWN_TOLERANCE_MINUTES,
  readEngineDownToleranceMinutes,
} from './billing-scheduler.config';
import { BILLING_SCHEDULER_REPOSITORY } from './billing-scheduler.constants';
import { BillingSchedulerRepository } from './billing-scheduler.repository';
import { BillingSchedulerService } from './billing-scheduler.service';

@Module({
  imports: [HealthModule, CalendarModule],
  providers: [
    BillingSchedulerService,
    {
      provide: BILLING_SCHEDULER_REPOSITORY,
      useClass: BillingSchedulerRepository,
    },
    {
      provide: ENGINE_DOWN_TOLERANCE_MINUTES,
      useFactory: () => readEngineDownToleranceMinutes(),
    },
  ],
  exports: [BillingSchedulerService, BILLING_SCHEDULER_REPOSITORY],
})
export class SchedulerModule {}
