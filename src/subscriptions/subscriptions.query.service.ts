import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service';
import { ErrorCode } from '../common/errors/error-code';
import { SUBSCRIPTION_QUERIES } from './subscriptions.constants';
import type {
  PaymentAttemptHistoryResponse,
  SubscriptionDetailRecord,
  SubscriptionDetailResponse,
  SubscriptionQueriesPort,
} from './subscriptions.types';

@Injectable()
export class SubscriptionsQueryService {
  constructor(
    @Inject(SUBSCRIPTION_QUERIES)
    private readonly queries: SubscriptionQueriesPort,
    private readonly calendar: CalendarService,
  ) {}

  async findById(id: string): Promise<SubscriptionDetailResponse> {
    const history = await this.queries.findHistory(id);

    if (history === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    const { subscription, billingIntents, paymentAttempts } = history;
    const attemptsByIntent = this.groupAttempts(paymentAttempts);

    return {
      id: subscription.id,
      amount: Number(subscription.amount),
      currency: subscription.currency,
      frequency: subscription.frequency,
      startDate: subscription.startDate,
      timezone: subscription.timezone,
      status: subscription.status,
      nextBillingDate: this.nextBillingDate(subscription),
      createdAt: subscription.createdAt.toISOString(),
      cancelledAt: subscription.cancelledAt
        ? subscription.cancelledAt.toISOString()
        : null,
      billingIntents: billingIntents.map((intent) => ({
        id: intent.id,
        billingCycle: intent.billingCycle,
        scheduleDate: intent.scheduleDate,
        amount: Number(intent.amount),
        currency: intent.currency,
        status: intent.status,
        settledAt: intent.settledAt ? intent.settledAt.toISOString() : null,
        createdAt: intent.createdAt.toISOString(),
        omittedReason: intent.omittedReason,
        needsManualReview: intent.needsManualReview,
        attempts: attemptsByIntent.get(intent.id) ?? [],
      })),
    };
  }

  private groupAttempts(
    attempts: readonly {
      id: string;
      billingIntentId: string;
      attemptNo: number | null;
      providerOperationId: string;
      status: PaymentAttemptHistoryResponse['status'];
      errorType: string | null;
      startedAt: Date;
      finishedAt: Date | null;
      trigger: PaymentAttemptHistoryResponse['trigger'];
    }[],
  ): Map<string, PaymentAttemptHistoryResponse[]> {
    const grouped = new Map<string, PaymentAttemptHistoryResponse[]>();

    for (const attempt of attempts) {
      const list = grouped.get(attempt.billingIntentId) ?? [];
      list.push({
        id: attempt.id,
        attemptNo: attempt.attemptNo,
        providerOperationId: attempt.providerOperationId,
        status: attempt.status,
        errorType: attempt.errorType,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt
          ? attempt.finishedAt.toISOString()
          : null,
        trigger: attempt.trigger,
      });
      grouped.set(attempt.billingIntentId, list);
    }

    return grouped;
  }

  private nextBillingDate(
    subscription: SubscriptionDetailRecord,
  ): string | null {
    if (subscription.status !== 'ACTIVE') {
      return null;
    }

    return this.calendar.nextBillingDate(
      subscription.startDate,
      subscription.frequency,
      this.calendar.today(),
    );
  }
}
