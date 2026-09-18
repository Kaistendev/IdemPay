import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode, errorCodeForStatus } from './error-code';
import { hasErrorCode } from './normalized-error';
import type { NormalizedError } from './normalized-error';

@Catch()
export class NormalizedErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(NormalizedErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.normalize(exception);
    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    body: NormalizedError | Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (hasErrorCode(payload)) {
        return { status, body: payload };
      }
      return {
        status,
        body: {
          error: errorCodeForStatus(status),
          message: this.messageOf(payload, exception.message),
        },
      };
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: ErrorCode.InternalError,
        message: 'Internal server error',
      },
    };
  }

  private messageOf(payload: string | object, fallback: string): string {
    if (typeof payload === 'string') {
      return payload;
    }
    if ('message' in payload && typeof payload.message === 'string') {
      return payload.message;
    }
    return fallback;
  }
}
