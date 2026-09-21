import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { GatewayModule } from '../gateway/gateway.module';
import { HealthModule } from '../health/health.module';
import { TransitionsModule } from '../transitions/transitions.module';
import {
  CHARGE_EXECUTOR,
  CHARGE_VERIFIER,
  INTERRUPTED_EXECUTION_RECOVERY,
} from './charge-executor.constants';
import { ChargeExecutorRepository } from './charge-executor.repository';
import { ChargeExecutorService } from './charge-executor.service';
import { ChargeRecoverySweepService } from './charge-recovery.sweep.service';
import {
  RECOVERY_SWEEP_INTERVAL,
  readRecoverySweepIntervalMs,
} from './charge-recovery.interval';
import {
  VERIFICATION_SWEEP_INTERVAL,
  readVerificationSweepIntervalMs,
} from './charge-verification.interval';
import { ChargeVerificationRepository } from './charge-verification.repository';
import { ChargeVerificationSweepService } from './charge-verification.sweep.service';
import { EXECUTION_TIMEOUT, readExecutionTimeoutMs } from './execution-timeout';
import { InterruptedExecutionRepository } from './interrupted-execution.repository';
import { RETRY_RAND } from '../retry/retry.constants';

@Module({
  imports: [CommonModule, HealthModule, GatewayModule, TransitionsModule],
  providers: [
    ChargeExecutorRepository,
    ChargeExecutorService,
    InterruptedExecutionRepository,
    ChargeRecoverySweepService,
    ChargeVerificationRepository,
    ChargeVerificationSweepService,
    { provide: CHARGE_EXECUTOR, useExisting: ChargeExecutorRepository },
    {
      provide: INTERRUPTED_EXECUTION_RECOVERY,
      useExisting: InterruptedExecutionRepository,
    },
    {
      provide: CHARGE_VERIFIER,
      useExisting: ChargeVerificationRepository,
    },
    {
      provide: RECOVERY_SWEEP_INTERVAL,
      useFactory: () => readRecoverySweepIntervalMs(),
    },
    {
      provide: VERIFICATION_SWEEP_INTERVAL,
      useFactory: () => readVerificationSweepIntervalMs(),
    },
    {
      provide: EXECUTION_TIMEOUT,
      useFactory: () => readExecutionTimeoutMs(),
    },
    { provide: RETRY_RAND, useValue: Math.random },
  ],
  exports: [
    CHARGE_EXECUTOR,
    INTERRUPTED_EXECUTION_RECOVERY,
    CHARGE_VERIFIER,
    ChargeExecutorService,
    ChargeVerificationSweepService,
  ],
})
export class ChargeExecutorModule {}
