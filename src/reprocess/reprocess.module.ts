import { Module } from '@nestjs/common';
import {
  EXECUTION_TIMEOUT,
  readExecutionTimeoutMs,
} from '../charge-executor/execution-timeout';
import { CommonModule } from '../common/common.module';
import { GatewayModule } from '../gateway/gateway.module';
import { HealthModule } from '../health/health.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { TransitionsModule } from '../transitions/transitions.module';
import { REPROCESS_REPOSITORY } from './reprocess.constants';
import { ReprocessController } from './reprocess.controller';
import { ReprocessRepository } from './reprocess.repository';
import { ReprocessService } from './reprocess.service';

@Module({
  imports: [
    CommonModule,
    HealthModule,
    GatewayModule,
    TransitionsModule,
    IdempotencyModule,
  ],
  controllers: [ReprocessController],
  providers: [
    ReprocessService,
    { provide: REPROCESS_REPOSITORY, useClass: ReprocessRepository },
    { provide: EXECUTION_TIMEOUT, useFactory: () => readExecutionTimeoutMs() },
  ],
  exports: [ReprocessService],
})
export class ReprocessModule {}
