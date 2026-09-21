import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  CHARGE_DISPATCH_INTERVAL,
  DISPATCH_BATCH_SIZE,
} from './dispatch.config';
import type {
  ChargeDispatchRepositoryPort,
  ChargeJobEnqueuer,
} from './dispatch.types';
import {
  CHARGES_QUEUE,
  DISPATCH_REPOSITORY,
  EXECUTE_JOB_NAME,
} from './queue.constants';

@Injectable()
export class ChargeDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DISPATCH_REPOSITORY)
    private readonly repository: ChargeDispatchRepositoryPort,
    @Inject(CHARGES_QUEUE) private readonly enqueuer: ChargeJobEnqueuer,
    @Inject(CHARGE_DISPATCH_INTERVAL) private readonly intervalMs: number,
    @Inject(DISPATCH_BATCH_SIZE) private readonly batchSize: number,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.dispatch();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispatch(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const due = await this.repository.dispatchDue(this.batchSize);
      for (const billingIntentId of due) {
        await this.enqueuer.add(
          EXECUTE_JOB_NAME,
          { billingIntentId },
          {
            jobId: billingIntentId,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      }
      return due.length;
    } catch {
      return 0;
    } finally {
      this.running = false;
    }
  }
}
