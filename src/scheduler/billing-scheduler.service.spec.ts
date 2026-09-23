// T47 — Scheduler: crear intents vencidas: @RF-11 @RF-23 @RF-24 @RF-25 @RF-30 @INV-02 @INV-08 @INV-09
// T48 — Omisión por motor caído: @RF-18 @RF-31
// T49 — No solapamiento de ciclos: @RF-14 @INV-01
import { CalendarService } from '../calendar/calendar.service';
import type {
  CalendarConfig,
  NonBusinessDaySource,
} from '../calendar/calendar.types';
import type { TimeService } from '../common/time/time.service';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import { BillingSchedulerService } from './billing-scheduler.service';
import type {
  BillingSchedulerRepositoryPort,
  SchedulableSubscription,
  SchedulerIntentExposure,
  SchedulerIntentSnapshot,
} from './billing-scheduler.types';

const TOLERANCE_MINUTES = 15;
const WEEKENDS: CalendarConfig = { nonBusinessWeekdays: [0, 6] };

class FakeHolidays implements NonBusinessDaySource {
  constructor(private readonly dates: string[] = []) {}

  listHolidays(): Promise<string[]> {
    return Promise.resolve(this.dates);
  }
}

const fakeTime = (today: string): TimeService =>
  ({ today: () => today }) as TimeService;

function calendar(today: string, holidays: string[] = []): CalendarService {
  return new CalendarService(
    WEEKENDS,
    new FakeHolidays(holidays),
    fakeTime(today),
  );
}

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `bi-${idCounter}`;
}

class RecordingSchedulerRepository implements BillingSchedulerRepositoryPort {
  private readonly subscriptions: SchedulableSubscription[];
  readonly intents: SchedulerIntentSnapshot[] = [];
  readonly scheduleAttempts: {
    subscriptionId: string;
    billingCycle: string;
  }[] = [];
  readonly omitAttempts: {
    subscriptionId: string;
    billingCycle: string;
    reason: 'ENGINE_DOWN' | 'OVERLAP';
  }[] = [];

  constructor(subscriptions: SchedulableSubscription[]) {
    this.subscriptions = subscriptions;
  }

  listActiveSubscriptions(): Promise<SchedulableSubscription[]> {
    return Promise.resolve(this.subscriptions);
  }

  listExistingIntents(
    subscriptionId: string,
  ): Promise<SchedulerIntentExposure[]> {
    return Promise.resolve(
      this.intents
        .filter((intent) => intent.subscriptionId === subscriptionId)
        .map((intent) => ({
          billingCycle: intent.billingCycle,
          status: intent.status,
        })),
    );
  }

  scheduleIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    this.scheduleAttempts.push({
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
    });
    const existing = this.intents.find(
      (intent) =>
        intent.subscriptionId === input.subscription.id &&
        intent.billingCycle === input.billingCycle,
    );
    if (existing) {
      return Promise.resolve(null);
    }
    const intent: SchedulerIntentSnapshot = {
      id: nextId(),
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      scheduleDate: input.scheduleDate,
      amount: input.subscription.amount,
      currency: input.subscription.currency,
      status: 'SCHEDULED',
      omittedReason: null,
    };
    this.intents.push(intent);
    return Promise.resolve(intent);
  }

  omitEngineDownIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    this.omitAttempts.push({
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      reason: 'ENGINE_DOWN',
    });
    return this.recordOmission(input, 'ENGINE_DOWN');
  }

  omitOverlapIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    this.omitAttempts.push({
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      reason: 'OVERLAP',
    });
    return this.recordOmission(input, 'OVERLAP');
  }

  private recordOmission(
    input: {
      subscription: SchedulableSubscription;
      billingCycle: string;
      scheduleDate: string;
    },
    reason: 'ENGINE_DOWN' | 'OVERLAP',
  ): Promise<SchedulerIntentSnapshot | null> {
    const existing = this.intents.find(
      (intent) =>
        intent.subscriptionId === input.subscription.id &&
        intent.billingCycle === input.billingCycle,
    );
    if (existing) {
      return Promise.resolve(null);
    }
    const intent: SchedulerIntentSnapshot = {
      id: nextId(),
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      scheduleDate: input.scheduleDate,
      amount: input.subscription.amount,
      currency: input.subscription.currency,
      status: 'OMITTED',
      omittedReason: reason,
    };
    this.intents.push(intent);
    return Promise.resolve(intent);
  }
}

function subscription(
  overrides: Partial<SchedulableSubscription> = {},
): SchedulableSubscription {
  return {
    id: 'sub-1',
    amount: 100,
    currency: 'USD',
    frequency: 'monthly',
    anchorDate: '2026-01-10',
    status: 'ACTIVE',
    ...overrides,
  };
}

function preexisting(
  billingCycle: string,
  scheduleDate: string,
  overrides: Partial<SchedulerIntentSnapshot> = {},
): SchedulerIntentSnapshot {
  return {
    id: nextId(),
    subscriptionId: 'sub-1',
    billingCycle,
    scheduleDate,
    amount: 100,
    currency: 'USD',
    status: 'SCHEDULED',
    omittedReason: null,
    ...overrides,
  };
}

describe('BillingSchedulerService', () => {
  it('creates a SCHEDULED intent for today and omits the overdue predecessor', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-03-02'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(1);
    expect(repository.intents).toHaveLength(2);
    expect(repository.intents[0]).toMatchObject({
      subscriptionId: 'sub-1',
      billingCycle: '2026-01-31',
      scheduleDate: '2026-02-02',
      status: 'OMITTED',
      omittedReason: 'ENGINE_DOWN',
    });
    expect(repository.intents[1]).toMatchObject({
      subscriptionId: 'sub-1',
      billingCycle: '2026-02-28',
      scheduleDate: '2026-03-02',
      status: 'SCHEDULED',
      omittedReason: null,
    });
  });

  it('omits every annual Feb-29 cycle passed and schedules the current one', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ frequency: 'annual', anchorDate: '2024-02-29' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-03-02'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(1);
    expect(repository.intents).toHaveLength(3);
    expect(repository.intents.map((i) => i.billingCycle)).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
    ]);
    expect(repository.intents[0].status).toBe('OMITTED');
    expect(repository.intents[1].status).toBe('OMITTED');
    expect(repository.intents[2]).toMatchObject({
      status: 'SCHEDULED',
      scheduleDate: '2026-03-02',
    });
  });

  it('creates the intent exactly on the business day that matches the nominal cycle', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-10' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-10'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(1);
    expect(repository.intents[1]).toMatchObject({
      billingCycle: '2026-02-10',
      scheduleDate: '2026-02-10',
      status: 'SCHEDULED',
    });
  });

  it('never creates a duplicate intent or a duplicate omission on a repeated sweep', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-10' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-10'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(1);
    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(2);
    expect(repository.scheduleAttempts).toHaveLength(1);
    expect(repository.omitAttempts).toHaveLength(1);
  });

  it('skips PAUSED and CANCELLED subscriptions', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ id: 'sub-active', anchorDate: '2026-01-10' }),
      subscription({
        id: 'sub-paused',
        anchorDate: '2026-01-10',
        status: 'PAUSED',
      }),
      subscription({
        id: 'sub-cancelled',
        anchorDate: '2026-01-10',
        status: 'CANCELLED',
      }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-10'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(1);
    expect(
      repository.intents.every((i) => i.subscriptionId === 'sub-active'),
    ).toBe(true);
  });

  it('does not create an intent before the subscription anchor', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-06-01' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-05-10'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(0);
  });

  it('does not charge a nominal cycle that lands on a non-business day', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-28'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(1);
    expect(repository.intents[0]).toMatchObject({
      billingCycle: '2026-01-31',
      status: 'OMITTED',
      omittedReason: 'ENGINE_DOWN',
    });
  });

  it('omits every cycle whose business date already passed', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-10' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-11'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(2);
    expect(repository.intents.map((i) => i.billingCycle)).toEqual([
      '2026-01-10',
      '2026-02-10',
    ]);
    expect(repository.intents.every((i) => i.status === 'OMITTED')).toBe(true);
  });

  it('defers the current cycle when its nominal business day is a holiday', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-10' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-02-10', ['2026-02-10']),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(1);
    expect(repository.intents[0]).toMatchObject({
      billingCycle: '2026-01-10',
      status: 'OMITTED',
    });
  });

  it('omits two missed cycles as ENGINE_DOWN and processes the next cycle normally', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    repository.intents.push(
      preexisting('2026-01-31', '2026-02-02', { status: 'SUCCEEDED' }),
    );
    let today = '2026-04-02';
    const time = { today: () => today } as unknown as TimeService;
    const service = new BillingSchedulerService(
      repository,
      new CalendarService(WEEKENDS, new FakeHolidays(), time),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.intents).toHaveLength(3);
    expect(repository.intents.map((i) => i.billingCycle)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(repository.intents[1]).toMatchObject({
      status: 'OMITTED',
      omittedReason: 'ENGINE_DOWN',
      scheduleDate: '2026-03-02',
    });
    expect(repository.intents[2]).toMatchObject({
      status: 'OMITTED',
      omittedReason: 'ENGINE_DOWN',
      scheduleDate: '2026-03-31',
    });
    expect(repository.omitAttempts.map((a) => a.billingCycle)).toEqual([
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(repository.scheduleAttempts).toHaveLength(0);

    today = '2026-04-30';
    await expect(service.sweep()).resolves.toBe(1);
    expect(repository.intents[3]).toMatchObject({
      billingCycle: '2026-04-30',
      scheduleDate: '2026-04-30',
      status: 'SCHEDULED',
    });
  });

  it('never catch-up-charges a cycle that was omitted', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-04-02'),
      TOLERANCE_MINUTES,
    );

    await service.sweep();
    await service.sweep();

    const omittedCycles = repository.intents
      .filter((i) => i.status === 'OMITTED')
      .map((i) => i.billingCycle);
    const scheduled = repository.intents.filter(
      (i) => i.status === 'SCHEDULED',
    );
    expect(omittedCycles).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(scheduled).toHaveLength(0);
  });

  it.each<BillingIntentStatus>([
    'SCHEDULED',
    'IN_FLIGHT',
    'RETRY_PENDING',
    'UNKNOWN',
  ])(
    'blocks the next cycle while a previous intent is %s (no overlap)',
    async (liveStatus) => {
      const repository = new RecordingSchedulerRepository([
        subscription({ anchorDate: '2026-01-31' }),
      ]);
      repository.intents.push(
        preexisting('2026-01-31', '2026-02-02', { status: liveStatus }),
      );
      const service = new BillingSchedulerService(
        repository,
        calendar('2026-03-02'),
        TOLERANCE_MINUTES,
      );

      await expect(service.sweep()).resolves.toBe(0);
      expect(repository.scheduleAttempts).toHaveLength(0);
      expect(repository.omitAttempts).toHaveLength(0);
      expect(repository.intents).toHaveLength(1);
    },
  );

  it('registers the skipped cycle OMITTED(OVERLAP) when the live intent outlasts N+2', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    repository.intents.push(
      preexisting('2026-01-31', '2026-02-02', { status: 'RETRY_PENDING' }),
    );
    const service = new BillingSchedulerService(
      repository,
      calendar('2026-03-31'),
      TOLERANCE_MINUTES,
    );

    await expect(service.sweep()).resolves.toBe(0);
    expect(repository.scheduleAttempts).toHaveLength(0);
    expect(repository.omitAttempts).toEqual([
      {
        subscriptionId: 'sub-1',
        billingCycle: '2026-02-28',
        reason: 'OVERLAP',
      },
    ]);
    expect(repository.intents[1]).toMatchObject({
      billingCycle: '2026-02-28',
      scheduleDate: '2026-03-02',
      status: 'OMITTED',
      omittedReason: 'OVERLAP',
    });
    expect(repository.intents).toHaveLength(2);
  });

  it.each<BillingIntentStatus>(['SUCCEEDED', 'FAILED_FINAL'])(
    'creates the next cycle once the previous intent is no longer alive (%s)',
    async (terminalStatus) => {
      const repository = new RecordingSchedulerRepository([
        subscription({ anchorDate: '2026-01-31' }),
      ]);
      repository.intents.push(
        preexisting('2026-01-31', '2026-02-02', { status: terminalStatus }),
      );
      const service = new BillingSchedulerService(
        repository,
        calendar('2026-03-02'),
        TOLERANCE_MINUTES,
      );

      await expect(service.sweep()).resolves.toBe(1);
      expect(repository.intents[1]).toMatchObject({
        billingCycle: '2026-02-28',
        scheduleDate: '2026-03-02',
        status: 'SCHEDULED',
        omittedReason: null,
      });
    },
  );

  it('keeps omitting OVERLAP while the intent stays alive and never catch-up-charges', async () => {
    const repository = new RecordingSchedulerRepository([
      subscription({ anchorDate: '2026-01-31' }),
    ]);
    repository.intents.push(
      preexisting('2026-01-31', '2026-02-02', { status: 'RETRY_PENDING' }),
    );
    let today = '2026-03-31';
    const time = { today: () => today } as unknown as TimeService;
    const service = new BillingSchedulerService(
      repository,
      new CalendarService(WEEKENDS, new FakeHolidays(), time),
      TOLERANCE_MINUTES,
    );

    await service.sweep();
    today = '2026-04-30';
    await service.sweep();
    expect(repository.omitAttempts.map((a) => a.billingCycle)).toEqual([
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(repository.omitAttempts.every((a) => a.reason === 'OVERLAP')).toBe(
      true,
    );
    expect(
      repository.intents.filter((i) => i.status === 'SCHEDULED'),
    ).toHaveLength(0);

    repository.intents[0].status = 'SUCCEEDED';
    today = '2026-06-01';
    await expect(service.sweep()).resolves.toBe(1);
    const scheduledCycles = repository.intents
      .filter((i) => i.status === 'SCHEDULED')
      .map((i) => i.billingCycle);
    expect(scheduledCycles).toEqual(['2026-05-31']);
  });
});
