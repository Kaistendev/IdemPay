import { Injectable, Inject, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { PG_POOL, REDIS_CLIENT } from './health.constants';

@Injectable()
export class HealthResources implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown() {
    await this.pool.end();
    this.redis.disconnect();
  }
}
