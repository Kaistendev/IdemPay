import { NotFoundException } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service';
import type { NonBusinessDaySource } from '../calendar/calendar.types';
import type { Clock } from '../common/time/clock';
import { TimeService } from '../common/time/time.service';
import { SubscriptionsQueryService } from './subscriptions.query.service';
import type {
  SubscriptionHistory,
  SubscriptionQueriesPort,
} from './subscriptions.types';

const NOW = new Date('2026-05-10T12:00:00Z');

class FakeSubscriptionQueries implements SubscriptionQueriesPort {
  constructor(private readonly history: SubscriptionHistory | null) {}

  findHistory(): Promise<SubscriptionHistory | null> {
    return Promise.resolve(this.history);
  }
}

class FakeNonBusinessDaySource implements NonBusinessDaySource {
  listHolidays(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

const history = (
  overrides: Partial<SubscriptionHistory> = {},
): SubscriptionHistory => ({
  subscription: {
    id: 'sub-1',
    amount: '1500.000000',
    currency: 'USD',
    frequency: 'monthly',
    startDate: '2026-05-20',
    timezone: 'UTC',
    status: 'ACTIVE',
    createdAt: NOW,
    cancelledAt: null,
  },
  billingIntents: [
    {
      id: 'int-1',
      billingCycle: '2026-04-20',
      scheduleDate: '2026-04-20',
      amount: '1500.000000',
      currency: 'USD',
      status: 'FAILED_FINAL',
      settledAt: NOW,
      createdAt: NOW,
      omittedReason: null,
      needsManualReview: false,
    },
    {
      id: 'int-2',
      billingCycle: '2026-05-20',
      scheduleDate: '2026-05-20',
      amount: '1500.000000',
      currency: 'USD',
      status: 'SCHEDULED',
      settledAt: null,
      createdAt: NOW,
      omittedReason: null,
      needsManualReview: false,
    },
    {
      id: 'int-3',
      billingCycle: '2026-06-20',
      scheduleDate: '2026-06-20',
      amount: '1500.000000',
      currency: 'USD',
      status: 'OMITTED',
      settledAt: NOW,
      createdAt: NOW,
      omittedReason: 'OVERLAP',
      needsManualReview: false,
    },
  ],
  paymentAttempts: [
    {
      id: 'att-1',
      billingIntentId: 'int-1',
      attemptNo: 1,
      providerOperationId: 'po-1',
      status: 'FAILED',
      errorType: 'DECLINED',
      startedAt: NOW,
      finishedAt: NOW,
      trigger: 'AUTO',
    },
    {
      id: 'att-2',
      billingIntentId: 'int-1',
      attemptNo: 2,
      providerOperationId: 'po-2',
      status: 'FAILED',
      errorType: 'PROVIDER_ERROR',
      startedAt: NOW,
      finishedAt: NOW,
      trigger: 'AUTO',
    },
    {
      id: 'att-3',
      billingIntentId: 'int-1',
      attemptNo: null,
      providerOperationId: 'po-3',
      status: 'FAILED',
      errorType: 'DECLINED',
      startedAt: NOW,
      finishedAt: NOW,
      trigger: 'MANUAL',
    },
  ],
  ...overrides,
});

describe('SubscriptionsQueryService', () => {
  const clock: Clock = { now: () => NOW };
  const time = new TimeService(clock, 'UTC');
  const calendar = new CalendarService(
    { nonBusinessWeekdays: [0, 6] },
    new FakeNonBusinessDaySource(),
    time,
  );

  const serviceFor = (source: SubscriptionHistory | null) =>
    new SubscriptionsQueryService(
      new FakeSubscriptionQueries(source),
      calendar,
    );

  it('returns the subscription, next billing date and full history', async () => {
    const result = await serviceFor(history()).findById('sub-1');

    expect(result).toMatchObject({
      id: 'sub-1',
      amount: 1500,
      currency: 'USD',
      frequency: 'monthly',
      startDate: '2026-05-20',
      timezone: 'UTC',
      status: 'ACTIVE',
      nextBillingDate: '2026-05-20',
      createdAt: NOW.toISOString(),
      cancelledAt: null,
    });

    expect(result.billingIntents).toHaveLength(3);
    expect(result.billingIntents[0]).toMatchObject({
      id: 'int-1',
      billingCycle: '2026-04-20',
      scheduleDate: '2026-04-20',
      amount: 1500,
      currency: 'USD',
      status: 'FAILED_FINAL',
      settledAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      omittedReason: null,
      needsManualReview: false,
    });
    expect(result.billingIntents[0].attempts).toEqual([
      {
        id: 'att-1',
        attemptNo: 1,
        providerOperationId: 'po-1',
        status: 'FAILED',
        errorType: 'DECLINED',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        trigger: 'AUTO',
      },
      {
        id: 'att-2',
        attemptNo: 2,
        providerOperationId: 'po-2',
        status: 'FAILED',
        errorType: 'PROVIDER_ERROR',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        trigger: 'AUTO',
      },
      {
        id: 'att-3',
        attemptNo: null,
        providerOperationId: 'po-3',
        status: 'FAILED',
        errorType: 'DECLINED',
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        trigger: 'MANUAL',
      },
    ]);
    expect(result.billingIntents[1]).toMatchObject({
      id: 'int-2',
      status: 'SCHEDULED',
      settledAt: null,
      omittedReason: null,
      needsManualReview: false,
      attempts: [],
    });
    expect(result.billingIntents[2]).toMatchObject({
      id: 'int-3',
      status: 'OMITTED',
      omittedReason: 'OVERLAP',
      needsManualReview: false,
    });
  });

  it('exposes omitted_reason, attempt trigger, failure reasons and needs_manual_review // T55: @RF-09', async () => {
    const source = history({
      billingIntents: history().billingIntents.map((intent, index) =>
        index === 0 ? { ...intent, needsManualReview: true } : intent,
      ),
    });

    const result = await serviceFor(source).findById('sub-1');

    const failed = result.billingIntents[0];
    expect(failed.needsManualReview).toBe(true);
    expect(failed.omittedReason).toBeNull();
    expect(failed.attempts.map((attempt) => attempt.trigger)).toEqual([
      'AUTO',
      'AUTO',
      'MANUAL',
    ]);
    expect(failed.attempts.map((attempt) => attempt.errorType)).toEqual([
      'DECLINED',
      'PROVIDER_ERROR',
      'DECLINED',
    ]);

    const omitted = result.billingIntents[2];
    expect(omitted.status).toBe('OMITTED');
    expect(omitted.omittedReason).toBe('OVERLAP');
  });

  it('omits the next billing date for a CANCELLED subscription', async () => {
    const source = history();
    source.subscription = {
      ...source.subscription,
      status: 'CANCELLED',
      cancelledAt: NOW,
    };

    const result = await serviceFor(source).findById('sub-1');

    expect(result.status).toBe('CANCELLED');
    expect(result.nextBillingDate).toBeNull();
    expect(result.cancelledAt).toBe(NOW.toISOString());
  });

  it('omits the next billing date for a PAUSED subscription', async () => {
    const source = history();
    source.subscription = { ...source.subscription, status: 'PAUSED' };

    const result = await serviceFor(source).findById('sub-1');

    expect(result.status).toBe('PAUSED');
    expect(result.nextBillingDate).toBeNull();
  });

  it('throws NOT_FOUND when the subscription does not exist', async () => {
    const error = await serviceFor(null)
      .findById('missing')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      error: 'NOT_FOUND',
    });
  });

  it.each([
    { frequency: 'monthly', startDate: '2026-01-10', today: '2026-05-10' },
    { frequency: 'monthly', startDate: '2026-01-31', today: '2026-05-10' },
    { frequency: 'annual', startDate: '2024-02-29', today: '2026-05-10' },
  ] as const)(
    'compares the GET next billing date with the CalendarModule for $frequency ($startDate) // T46: @RF-09 @RF-23 @INV-02',
    async ({ frequency, startDate }) => {
      const source = history({
        subscription: {
          ...history().subscription,
          startDate,
          frequency,
        },
      });
      const result = await serviceFor(source).findById('sub-1');

      expect(result.nextBillingDate).toBe(
        calendar.nextBillingDate(startDate, frequency, calendar.today()),
      );
    },
  );

  it('returns the same next billing date as the CalendarModule for end of month', async () => {
    const today = '2026-02-01';
    const clockAt: Clock = { now: () => new Date(`${today}T12:00:00Z`) };
    const calendarAt = new CalendarService(
      { nonBusinessWeekdays: [0, 6] },
      new FakeNonBusinessDaySource(),
      new TimeService(clockAt, 'UTC'),
    );

    const source = history({
      subscription: {
        ...history().subscription,
        startDate: '2026-01-31',
        frequency: 'monthly',
      },
    });
    const result = await new SubscriptionsQueryService(
      new FakeSubscriptionQueries(source),
      calendarAt,
    ).findById('sub-1');

    expect(result.nextBillingDate).toBe('2026-02-28');
    expect(result.nextBillingDate).toBe(
      calendarAt.nextBillingDate('2026-01-31', 'monthly', today),
    );
  });
});
