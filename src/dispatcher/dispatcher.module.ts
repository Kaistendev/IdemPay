import { Module } from '@nestjs/common';
import { ChargeExecutorModule } from '../charge-executor/charge-executor.module';
import { HealthModule } from '../health/health.module';
import { ChargeDispatcherService } from './charge-dispatcher.service';
import { ChargeExecutionWorker } from './charge-execution-worker';
import { ChargeQueueProvider } from './charge-queue.provider';
import {
  CHARGE_DISPATCH_INTERVAL,
  DISPATCH_BATCH_SIZE,
  readChargeDispatchIntervalMs,
  readDispatchBatchSize,
} from './dispatch.config';
import { DispatchRepository } from './dispatch.repository';
import {
  CHARGE_EXECUTION_CONNECTION,
  CHARGES_QUEUE,
  DISPATCH_REPOSITORY,
} from './queue.constants';
import { bullRedisOptions } from './redis-connection';

@Module({
  imports: [HealthModule, ChargeExecutorModule],
  providers: [
    DispatchRepository,
    ChargeDispatcherService,
    ChargeExecutionWorker,
    ChargeQueueProvider,
    { provide: DISPATCH_REPOSITORY, useExisting: DispatchRepository },
    { provide: CHARGES_QUEUE, useClass: ChargeQueueProvider },
    {
      provide: CHARGE_EXECUTION_CONNECTION,
      useFactory: () => bullRedisOptions(),
    },
    {
      provide: CHARGE_DISPATCH_INTERVAL,
      useFactory: () => readChargeDispatchIntervalMs(),
    },
    {
      provide: DISPATCH_BATCH_SIZE,
      useFactory: () => readDispatchBatchSize(),
    },
  ],
  exports: [
    DISPATCH_REPOSITORY,
    CHARGE_DISPATCH_INTERVAL,
    ChargeDispatcherService,
    ChargeExecutionWorker,
  ],
})
export class DispatcherModule {}
