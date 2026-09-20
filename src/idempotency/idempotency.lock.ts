import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../health/health.constants';
import {
  IDEMPOTENCY_LOCK_MS,
  idempotencyLockKey,
} from './idempotency.constants';

@Injectable()
export class IdempotencyKeyLock {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async acquire(key: string): Promise<boolean> {
    try {
      const result = await this.redis.set(
        idempotencyLockKey(key),
        '1',
        'PX',
        IDEMPOTENCY_LOCK_MS,
        'NX',
      );
      return result === 'OK';
    } catch {
      return true;
    }
  }
}
