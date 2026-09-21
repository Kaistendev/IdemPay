import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { ChargeJobEnqueuer } from './dispatch.types';
import { CHARGES_EXECUTE_QUEUE } from './queue.constants';
import { bullRedisOptions } from './redis-connection';

@Injectable()
export class ChargeQueueProvider implements ChargeJobEnqueuer, OnModuleDestroy {
  private readonly queue = new Queue(CHARGES_EXECUTE_QUEUE, {
    connection: bullRedisOptions(),
  });

  async add(
    name: string,
    data: { billingIntentId: string },
    options?: {
      jobId?: string;
      removeOnComplete?: boolean;
      removeOnFail?: boolean;
    },
  ): Promise<unknown> {
    return this.queue.add(name, data, options);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
