import { Inject, Injectable } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { IDEMPOTENCY_STORE } from './idempotency.constants';
import type { IdempotencyRequest } from './idempotency.context';
import type { IdempotencyStorePort } from './idempotency.types';

@Injectable()
export class IdempotencySettlementInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStorePort,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    const operation = request.idempotencyOperationContext;

    if (!operation) {
      return next.handle();
    }

    if (operation.replay) {
      const replay = operation.replay;
      context.switchToHttp().getResponse<Response>().status(replay.statusCode);
      return of(replay.body);
    }

    if (!operation.acquired) {
      return next.handle();
    }

    const statusCode = this.resolveStatusCode(context);

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.store.settle(operation.key, {
          response: { statusCode, body },
          billingIntentRef: operation.billingIntentRef,
        });
        return body;
      }),
    );
  }

  private resolveStatusCode(context: ExecutionContext): number {
    const explicit = this.reflector.getAllAndOverride<number>(
      HTTP_CODE_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (typeof explicit === 'number') {
      return explicit;
    }
    const request = context.switchToHttp().getRequest<Request>();
    return request.method === 'POST' ? 201 : 200;
  }
}
