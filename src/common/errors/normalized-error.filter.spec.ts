import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NormalizedErrorFilter } from './normalized-error.filter';

function buildHost(response: unknown): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

describe('NormalizedErrorFilter', () => {
  let filter: NormalizedErrorFilter;
  let status: jest.Mock;
  let json: jest.Mock;
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new NormalizedErrorFilter();
    json = jest.fn();
    status = jest.fn(() => ({ json }));
    host = buildHost({ status, json });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes through an already normalized body', () => {
    filter.catch(
      new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
    });
  });

  it('preserves spec-shaped bodies such as the 423 lock', () => {
    filter.catch(
      new HttpException(
        { error: 'IDEMPOTENCY_LOCKED', status: 'PROCESSING' },
        423,
      ),
      host,
    );

    expect(status).toHaveBeenCalledWith(423);
    expect(json).toHaveBeenCalledWith({
      error: 'IDEMPOTENCY_LOCKED',
      status: 'PROCESSING',
    });
  });

  it('normalizes a plain HttpException', () => {
    filter.catch(new NotFoundException('Subscription not found'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: 'NOT_FOUND',
      message: 'Subscription not found',
    });
  });

  it('maps unexpected errors to a 500 without leaking details', () => {
    filter.catch(new Error('database exploded'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
