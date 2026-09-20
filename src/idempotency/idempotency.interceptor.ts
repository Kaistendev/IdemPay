import { Inject, Injectable } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { IdempotencyRequest } from './idempotency.context';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyUnitOfWork } from './idempotency.uow';

@Injectable()
export class IdempotencySettlementInterceptor implements NestInterceptor {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: IdempotencyRepository,
    private readonly uow: IdempotencyUnitOfWork,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
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

    if (!operation.acquired || operation.generation === null) {
      return next.handle();
    }

    const statusCode = this.resolveStatusCode(context);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const body: unknown = await this.uow.run(client, () =>
        lastValueFrom(next.handle()),
      );
      await this.repository.settle(
        client,
        operation.key,
        operation.generation,
        {
          response: { statusCode, body },
          billingIntentRef: operation.billingIntentRef,
        },
      );
      await client.query('COMMIT');
      return of(body);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
