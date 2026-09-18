import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

interface Transformer {
  transform(value: unknown): unknown;
}

function catchBadRequest(
  transformer: Transformer,
  payload: unknown,
): BadRequestException {
  try {
    transformer.transform(payload);
  } catch (error) {
    if (error instanceof BadRequestException) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected ZodValidationPipe to throw BadRequestException');
}

function issuePaths(error: BadRequestException): string[] {
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null || !('details' in body)) {
    throw new Error('Expected a details array in the validation error body');
  }
  if (!Array.isArray(body.details)) {
    throw new Error('Expected details to be an array');
  }
  const details = body.details as unknown[];
  return details.map((detail) => {
    if (
      typeof detail === 'object' &&
      detail !== null &&
      'path' in detail &&
      typeof detail.path === 'string'
    ) {
      return detail.path;
    }
    throw new Error('Expected each detail to expose a string path');
  });
}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed DTO when the payload is valid', () => {
    expect(pipe.transform({ amount: 1500, currency: 'ARS' })).toEqual({
      amount: 1500,
      currency: 'ARS',
    });
  });

  it('rejects an invalid payload with a 400 and a normalized body', () => {
    const error = catchBadRequest(pipe, { amount: -5, currency: 'US' });

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request payload',
    });
  });

  it('lists every invalid field with its path', () => {
    const error = catchBadRequest(pipe, { amount: -5, currency: 'US' });

    expect(issuePaths(error)).toEqual(
      expect.arrayContaining(['amount', 'currency']),
    );
  });

  it('rejects non-object payloads', () => {
    const error = catchBadRequest(pipe, 'not-an-object');

    expect(error.getResponse()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });
});
