import type { ChargeExecutionResult } from '../charge-executor/charge-executor.types';
import { ChargeExecutionWorker } from './charge-execution-worker';

const INTENT = '11111111-1111-1111-1111-111111111111';

class FakeExecutor {
  readonly calls: string[] = [];
  outcome: ChargeExecutionResult['outcome'] = 'SUCCEEDED';

  execute(billingIntentId: string): Promise<ChargeExecutionResult> {
    this.calls.push(billingIntentId);
    return {
      outcome: this.outcome,
      billingIntentId,
    } as ChargeExecutionResult;
  }
}

describe('ChargeExecutionWorker', () => {
  it('executes the charge for the job payload billing intent', async () => {
    const executor = new FakeExecutor();
    const worker = new ChargeExecutionWorker(executor as never, {});

    await worker.executeJob(INTENT);

    expect(executor.calls).toEqual([INTENT]);
  });

  it('marks the job completed even when the intent is not startable', async () => {
    const executor = new FakeExecutor();
    executor.outcome = 'NOT_STARTED';
    const worker = new ChargeExecutionWorker(executor as never, {});

    await expect(worker.executeJob(INTENT)).resolves.toBeUndefined();
    expect(executor.calls).toEqual([INTENT]);
  });
});
