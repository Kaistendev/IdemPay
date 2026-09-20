import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

interface IdempotencyTransactionStore {
  client: PoolClient;
}

@Injectable()
export class IdempotencyUnitOfWork {
  private readonly storage =
    new AsyncLocalStorage<IdempotencyTransactionStore>();

  run<T>(client: PoolClient, task: () => Promise<T>): Promise<T> {
    return this.storage.run({ client }, task);
  }

  current(): PoolClient | null {
    return this.storage.getStore()?.client ?? null;
  }
}
