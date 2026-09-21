import { ChargeDispatcherService } from './charge-dispatcher.service';
import type {
  ChargeDispatchRepositoryPort,
  ChargeJobEnqueuer,
} from './dispatch.types';

const INTERVAL_MS = 10_000;
const BATCH_SIZE = 10;

class StubDispatchRepository implements ChargeDispatchRepositoryPort {
  calls = 0;
  lastBatchSize: number | null = null;

  constructor(private readonly ids: string[]) {}

  dispatchDue(batchSize: number): Promise<string[]> {
    this.calls += 1;
    this.lastBatchSize = batchSize;
    return Promise.resolve([...this.ids]);
  }
}

class BlockingDispatchRepository implements ChargeDispatchRepositoryPort {
  calls = 0;
  private resolveCurrent: (() => void) | null = null;

  dispatchDue(): Promise<string[]> {
    this.calls += 1;
    return new Promise((resolve) => {
      this.resolveCurrent = () => resolve([]);
    });
  }

  finishCurrent(): void {
    const resolve = this.resolveCurrent;
    this.resolveCurrent = null;
    resolve?.();
  }
}

class FakeEnqueuer implements ChargeJobEnqueuer {
  readonly enqueued: { billingIntentId: string; jobId?: string }[] = [];
  shouldFail = false;

  add(
    _name: string,
    data: { billingIntentId: string },
    options?: { jobId?: string },
  ): Promise<unknown> {
    if (this.shouldFail) {
      return Promise.reject(new Error('queue unavailable'));
    }
    this.enqueued.push({
      billingIntentId: data.billingIntentId,
      jobId: options?.jobId,
    });
    return Promise.resolve({ id: data.billingIntentId });
  }
}

describe('ChargeDispatcherService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueues every due intent with its id as the deterministic job id', async () => {
    const repository = new StubDispatchRepository(['intent-a', 'intent-b']);
    const enqueuer = new FakeEnqueuer();
    const service = new ChargeDispatcherService(
      repository,
      enqueuer,
      INTERVAL_MS,
      BATCH_SIZE,
    );

    const dispatched = await service.dispatch();

    expect(dispatched).toBe(2);
    expect(enqueuer.enqueued).toEqual([
      { billingIntentId: 'intent-a', jobId: 'intent-a' },
      { billingIntentId: 'intent-b', jobId: 'intent-b' },
    ]);
  });

  it('never runs two overlapping dispatches', async () => {
    const repository = new BlockingDispatchRepository();
    const enqueuer = new FakeEnqueuer();
    const service = new ChargeDispatcherService(
      repository,
      enqueuer,
      INTERVAL_MS,
      BATCH_SIZE,
    );

    const first = service.dispatch();
    const second = await service.dispatch();

    expect(second).toBe(0);
    expect(repository.calls).toBe(1);

    repository.finishCurrent();
    await expect(first).resolves.toBe(0);
  });

  it('keeps sweeping after an enqueue failure so the charge is not lost', async () => {
    const repository = new StubDispatchRepository(['intent-a']);
    const enqueuer = new FakeEnqueuer();
    const service = new ChargeDispatcherService(
      repository,
      enqueuer,
      INTERVAL_MS,
      BATCH_SIZE,
    );

    enqueuer.shouldFail = true;
    await expect(service.dispatch()).resolves.toBe(0);
    expect(enqueuer.enqueued).toHaveLength(0);

    enqueuer.shouldFail = false;
    await expect(service.dispatch()).resolves.toBe(1);
    expect(enqueuer.enqueued).toEqual([
      { billingIntentId: 'intent-a', jobId: 'intent-a' },
    ]);
  });

  it('dispatches on every interval tick and stops when destroyed', async () => {
    const repository = new StubDispatchRepository([]);
    const enqueuer = new FakeEnqueuer();
    const service = new ChargeDispatcherService(
      repository,
      enqueuer,
      INTERVAL_MS,
      BATCH_SIZE,
    );

    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(repository.calls).toBe(1);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(repository.calls).toBe(2);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(repository.calls).toBe(2);
  });
});
