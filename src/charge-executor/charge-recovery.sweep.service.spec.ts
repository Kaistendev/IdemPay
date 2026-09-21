import type { InterruptedExecutionRecoveryPort } from './interrupted-execution.types';
import type { RecoveredExecution } from './interrupted-execution.types';
import { ChargeRecoverySweepService } from './charge-recovery.sweep.service';

const INTERVAL_MS = 10_000;

class ControlledRecovery implements InterruptedExecutionRecoveryPort {
  calls = 0;
  private resolveCurrent: (() => void) | null = null;

  recoverExpired(): Promise<RecoveredExecution[]> {
    this.calls += 1;
    return new Promise((resolve) => {
      this.resolveCurrent = () => resolve([]);
    });
  }

  finishCurrent(): void {
    this.resolveCurrent?.();
    this.resolveCurrent = null;
  }
}

describe('ChargeRecoverySweepService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the recovery sweep on every configured interval tick', async () => {
    const recovery = new ControlledRecovery();
    const service = new ChargeRecoverySweepService(recovery, INTERVAL_MS);

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(recovery.calls).toBe(1);

    recovery.finishCurrent();
    await Promise.resolve();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(recovery.calls).toBe(2);
  });

  it('stops sweeping after the service is destroyed', async () => {
    const recovery = new ControlledRecovery();
    const service = new ChargeRecoverySweepService(recovery, INTERVAL_MS);

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(recovery.calls).toBe(1);
  });

  it('never runs two overlapping sweeps', async () => {
    const recovery = new ControlledRecovery();
    const service = new ChargeRecoverySweepService(recovery, INTERVAL_MS);

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(recovery.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(recovery.calls).toBe(1);

    recovery.finishCurrent();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(recovery.calls).toBe(2);
  });
});
