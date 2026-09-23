import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode } from '../common/errors/error-code';
import { hashCanonicalPayload } from '../common/idempotency/payload-hash';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency.constants';
import type { IdempotencyRequest } from './idempotency.context';
import { IdempotencyKeyLock } from './idempotency.lock';
import { IdempotencyRepository } from './idempotency.repository';
import type { IdempotencyOperationType } from './idempotency.types';

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly lock: IdempotencyKeyLock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    const key = this.readKey(request.headers['idempotency-key']);
    const payloadHash = hashCanonicalPayload(request.body ?? {});
    const operationType = this.operationTypeFor(request);

    await this.lock.acquire(key);

    const registration = await this.repository.registerOrGet(
      key,
      payloadHash,
      operationType,
    );

    if (registration.outcome === 'NEW' || registration.outcome === 'RETAKE') {
      request.idempotencyOperationContext = {
        key,
        payloadHash,
        acquired: true,
        generation: registration.generation,
        billingIntentRef: null,
        replay: null,
      };
      return true;
    }

    if (registration.outcome === 'MISMATCH') {
      throw new ConflictException({
        error: ErrorCode.IdempotencyPayloadMismatch,
        message: 'Idempotency-Key was already used with a different payload',
      });
    }

    if (registration.outcome === 'IN_FLIGHT') {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader(
        'Retry-After',
        String(registration.leaseRemainingSeconds),
      );
      throw new HttpException(
        {
          error: ErrorCode.IdempotencyLocked,
          message: 'An operation with this Idempotency-Key is in flight',
          status: 'PROCESSING',
        },
        HttpStatus.LOCKED,
      );
    }

    request.idempotencyOperationContext = {
      key,
      payloadHash,
      acquired: false,
      generation: null,
      billingIntentRef: registration.billingIntentId,
      replay: registration.response,
    };
    return true;
  }

  private readKey(header: unknown): string {
    const raw: unknown = Array.isArray(header)
      ? (header as unknown[])[0]
      : header;

    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException({
        error: ErrorCode.IdempotencyKeyRequired,
        message: 'Idempotency-Key header is required',
      });
    }

    if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException({
        error: ErrorCode.IdempotencyKeyTooLong,
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      });
    }

    return raw;
  }

  private operationTypeFor(
    request: IdempotencyRequest,
  ): IdempotencyOperationType {
    const method = request.method ?? '';
    if (method !== 'POST') {
      return 'SUBSCRIPTION_CREATE';
    }
    const path = request.path ?? '';
    if (/^\/subscriptions\/[^/]+\/pause$/.test(path)) {
      return 'SUBSCRIPTION_PAUSE';
    }
    if (/^\/subscriptions\/[^/]+\/resume$/.test(path)) {
      return 'SUBSCRIPTION_RESUME';
    }
    if (/^\/subscriptions\/[^/]+\/cancel$/.test(path)) {
      return 'SUBSCRIPTION_CANCEL';
    }
    if (/^\/subscriptions\/[^/]+\/reprocess$/.test(path)) {
      return 'BILLING_INTENT_REPROCESS';
    }
    if (
      /^\/subscriptions\/[^/]+\/billing-cycles\/[^/]+\/reprocess$/.test(path)
    ) {
      return 'BILLING_INTENT_REPROCESS';
    }
    if (/^\/subscriptions\/[^/]+\/billing-cycles\/[^/]+\/charge$/.test(path)) {
      return 'BILLING_CYCLE_CHARGE';
    }
    if (/^\/charges$/.test(path)) {
      return 'BILLING_CYCLE_CHARGE';
    }
    return 'SUBSCRIPTION_CREATE';
  }
}
