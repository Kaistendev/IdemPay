import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HealthResources } from './health.resources';
import { PG_POOL, REDIS_CLIENT } from './health.constants';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString:
            process.env.DATABASE_URL ??
            'postgresql://idem:idem@localhost:5433/idem',
        }),
    },
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    },
    HealthService,
    HealthResources,
  ],
  exports: [PG_POOL, REDIS_CLIENT, HealthService],
})
export class HealthModule {}
