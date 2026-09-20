import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { HealthModule } from '../health/health.module';
import { IDEMPOTENCY_KEY_LOCK } from './idempotency.constants';
import { IdempotencyGuard } from './idempotency.guard';
import { IdempotencySettlementInterceptor } from './idempotency.interceptor';
import { IdempotencyKeyLock } from './idempotency.lock';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyUnitOfWork } from './idempotency.uow';

@Module({
  imports: [HealthModule, CommonModule],
  providers: [
    IdempotencyKeyLock,
    { provide: IDEMPOTENCY_KEY_LOCK, useExisting: IdempotencyKeyLock },
    IdempotencyRepository,
    IdempotencyGuard,
    IdempotencySettlementInterceptor,
    IdempotencyUnitOfWork,
  ],
  exports: [
    HealthModule,
    IdempotencyKeyLock,
    IDEMPOTENCY_KEY_LOCK,
    IdempotencyRepository,
    IdempotencyGuard,
    IdempotencySettlementInterceptor,
    IdempotencyUnitOfWork,
  ],
})
export class IdempotencyModule {}
