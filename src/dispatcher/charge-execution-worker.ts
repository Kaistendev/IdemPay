import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';
import { ChargeExecutorService } from '../charge-executor/charge-executor.service';
import {
  CHARGE_EXECUTION_CONNECTION,
  CHARGES_EXECUTE_QUEUE,
} from './queue.constants';

interface ExecuteJobData {
  billingIntentId: string;
}

@Injectable()
export class ChargeExecutionWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker: Worker | null = null;

  constructor(
    @Inject(ChargeExecutorService)
    private readonly executor: ChargeExecutorService,
    @Inject(CHARGE_EXECUTION_CONNECTION)
    private readonly connection: ConnectionOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<ExecuteJobData>(
      CHARGES_EXECUTE_QUEUE,
      (job: Job<ExecuteJobData>) => this.executeJob(job.data.billingIntentId),
      { connection: this.connection, concurrency: 1 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
  }

  async executeJob(billingIntentId: string): Promise<void> {
    await this.executor.execute(billingIntentId);
  }
}
