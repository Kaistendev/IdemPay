import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { TimeService } from '../common/time/time.service';
import type { CreateSubscriptionRequest } from './subscription.schema';
import { SUBSCRIPTIONS_REPOSITORY } from './subscriptions.constants';
import type {
  SubscriptionResponse,
  SubscriptionsRepositoryPort,
} from './subscriptions.types';

@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(SUBSCRIPTIONS_REPOSITORY)
    private readonly repository: SubscriptionsRepositoryPort,
    private readonly time: TimeService,
  ) {}

  async create(
    request: CreateSubscriptionRequest,
  ): Promise<SubscriptionResponse> {
    if (request.startDate < this.time.today()) {
      throw new BadRequestException({
        error: ErrorCode.ValidationError,
        message: 'Invalid request payload',
        details: [
          {
            path: 'startDate',
            code: 'not_allowed',
            message: 'startDate must not be in the past',
          },
        ],
      });
    }

    const record = await this.repository.insert(request);

    return {
      id: record.id,
      amount: Number(record.amount),
      currency: record.currency,
      frequency: record.frequency,
      startDate: record.startDate,
      timezone: record.timezone,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
