import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';
import { ErrorCode } from '../errors/error-code';
import { mapZodIssues } from '../errors/map-zod-issues';
import type { NormalizedError } from '../errors/normalized-error';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const body: NormalizedError = {
        error: ErrorCode.ValidationError,
        message: 'Invalid request payload',
        details: mapZodIssues(result.error.issues),
      };
      throw new BadRequestException(body);
    }
    return result.data;
  }
}
