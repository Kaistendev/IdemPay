import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { GatewayModule } from '../gateway/gateway.module';
import { HealthModule } from '../health/health.module';
import {
  CHARGE_EXECUTOR,
  INTERRUPTED_EXECUTION_RECOVERY,
} from './charge-executor.constants';
import { ChargeExecutorRepository } from './charge-executor.repository';
import { ChargeExecutorService } from './charge-executor.service';
import { EXECUTION_TIMEOUT, readExecutionTimeoutMs } from './execution-timeout';
import { InterruptedExecutionRepository } from './interrupted-execution.repository';

@Module({
  imports: [CommonModule, HealthModule, GatewayModule],
  providers: [
    ChargeExecutorRepository,
    ChargeExecutorService,
    InterruptedExecutionRepository,
    { provide: CHARGE_EXECUTOR, useExisting: ChargeExecutorRepository },
    {
      provide: INTERRUPTED_EXECUTION_RECOVERY,
      useExisting: InterruptedExecutionRepository,
    },
    {
      provide: EXECUTION_TIMEOUT,
      useFactory: () => readExecutionTimeoutMs(),
    },
  ],
  exports: [
    CHARGE_EXECUTOR,
    INTERRUPTED_EXECUTION_RECOVERY,
    ChargeExecutorService,
  ],
})
export class ChargeExecutorModule {}
