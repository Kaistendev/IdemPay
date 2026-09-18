import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { IdempotencyResponse } from './idempotency.types';

export interface IdempotencyOperationContext {
  key: string;
  payloadHash: string;
  acquired: boolean;
  billingIntentRef: string | null;
  replay: IdempotencyResponse | null;
}

export interface IdempotencyRequest extends Request {
  idempotencyOperationContext?: IdempotencyOperationContext;
}

export const IdempotencyContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IdempotencyOperationContext => {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    if (!request.idempotencyOperationContext) {
      throw new Error('Idempotency context is not available for this request');
    }
    return request.idempotencyOperationContext;
  },
);
