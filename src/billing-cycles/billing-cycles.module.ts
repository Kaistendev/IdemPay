import { Module } from '@nestjs/common';
import { ChargeExecutorModule } from '../charge-executor/charge-executor.module';
import { CommonModule } from '../common/common.module';
import { HealthModule } from '../health/health.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { BILLING_CYCLE_REPOSITORY } from './billing-cycle.constants';
import { BillingCycleRepository } from './billing-cycle.repository';
import { BillingCycleChargeService } from './billing-cycle.service';
import { BillingCyclesController } from './billing-cycles.controller';

@Module({
  imports: [
    CommonModule,
    HealthModule,
    IdempotencyModule,
    ChargeExecutorModule,
  ],
  controllers: [BillingCyclesController],
  providers: [
    BillingCycleChargeService,
    { provide: BILLING_CYCLE_REPOSITORY, useClass: BillingCycleRepository },
  ],
  exports: [BillingCycleChargeService, BILLING_CYCLE_REPOSITORY],
})
export class BillingCyclesModule {}
