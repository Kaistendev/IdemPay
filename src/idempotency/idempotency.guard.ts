import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { hashCanonicalPayload } from '../common/idempotency/payload-hash';
import {
  IDEMPOTENCY_STORE,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './idempotency.constants';
import type { IdempotencyRequest } from './idempotency.context';
import type { IdempotencyStorePort } from './idempotency.types';

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStorePort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    const key = this.readKey(request.headers['idempotency-key']);
    const payloadHash = hashCanonicalPayload(request.body ?? {});

    const result = await this.store.begin(key, payloadHash);

    if (result.acquired) {
      request.idempotencyOperationContext = {
        key,
        payloadHash,
        acquired: true,
        billingIntentRef: null,
        replay: null,
      };
      return true;
    }

    if (result.record.payloadHash !== payloadHash) {
      throw new ConflictException({
        error: ErrorCode.IdempotencyPayloadMismatch,
        message: 'Idempotency-Key was already used with a different payload',
      });
    }

    if (result.record.state === 'PROCESSING') {
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
      billingIntentRef: null,
      replay: result.record.response,
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
}
