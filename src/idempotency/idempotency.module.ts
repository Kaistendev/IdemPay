import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { IDEMPOTENCY_STORE } from './idempotency.constants';
import { IdempotencyGuard } from './idempotency.guard';
import { IdempotencySettlementInterceptor } from './idempotency.interceptor';
import { IdempotencyStore } from './idempotency.store';

@Module({
  imports: [HealthModule],
  providers: [
    IdempotencyStore,
    { provide: IDEMPOTENCY_STORE, useExisting: IdempotencyStore },
    IdempotencyGuard,
    IdempotencySettlementInterceptor,
  ],
  exports: [
    IdempotencyStore,
    IDEMPOTENCY_STORE,
    IdempotencyGuard,
    IdempotencySettlementInterceptor,
  ],
})
export class IdempotencyModule {}
