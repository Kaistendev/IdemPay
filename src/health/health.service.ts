import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { PG_POOL, REDIS_CLIENT } from './health.constants';

export interface HealthDetails {
  database: 'up' | 'down';
  redis: 'up' | 'down';
}

export interface HealthResult {
  status: 'ok' | 'error';
  details: HealthDetails;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResult> {
    const [database, redis] = await Promise.all([
      this.isDatabaseUp(),
      this.isRedisUp(),
    ]);
    return {
      status: database && redis ? 'ok' : 'error',
      details: {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    };
  }

  private async isDatabaseUp(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async isRedisUp(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
