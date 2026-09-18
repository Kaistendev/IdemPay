import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { SUBSCRIPTION_CANCELLATION } from './subscriptions.constants';
import type {
  SubscriptionCancellationPort,
  SubscriptionCancellationResult,
} from './subscriptions.types';

@Injectable()
export class SubscriptionsCancellationService {
  constructor(
    @Inject(SUBSCRIPTION_CANCELLATION)
    private readonly repository: SubscriptionCancellationPort,
  ) {}

  async cancel(id: string): Promise<SubscriptionCancellationResult> {
    const result = await this.repository.cancel(id);

    if (result === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    return result;
  }
}
