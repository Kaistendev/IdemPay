import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { RECOVERY_SWEEP_INTERVAL } from './charge-recovery.interval';
import { INTERRUPTED_EXECUTION_RECOVERY } from './charge-executor.constants';
import type { InterruptedExecutionRecoveryPort } from './interrupted-execution.types';

@Injectable()
export class ChargeRecoverySweepService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(INTERRUPTED_EXECUTION_RECOVERY)
    private readonly recovery: InterruptedExecutionRecoveryPort,
    @Inject(RECOVERY_SWEEP_INTERVAL) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweep(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.recovery.recoverExpired();
    } catch {
      // best-effort sweep: the next tick retries
    } finally {
      this.running = false;
    }
  }
}
