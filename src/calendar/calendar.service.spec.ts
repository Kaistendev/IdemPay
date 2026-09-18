import { CalendarService } from './calendar.service';
import type { CalendarConfig, NonBusinessDaySource } from './calendar.types';
import type { TimeService } from '../common/time/time.service';

const WEEKENDS: CalendarConfig = { nonBusinessWeekdays: [0, 6] };

class FakeHolidays implements NonBusinessDaySource {
  constructor(private readonly dates: string[] = []) {}

  listHolidays(): Promise<string[]> {
    return Promise.resolve(this.dates);
  }
}

const fakeTime = (today: string): TimeService =>
  ({ today: () => today }) as TimeService;

describe('CalendarService', () => {
  it('exposes the single scheduling date as today', () => {
    const service = new CalendarService(
      WEEKENDS,
      new FakeHolidays(),
      fakeTime('2026-05-10'),
    );

    expect(service.today()).toBe('2026-05-10');
  });

  it('evaluates business days against the configured weekend', async () => {
    const service = new CalendarService(
      WEEKENDS,
      new FakeHolidays(),
      fakeTime('2026-05-10'),
    );

    await expect(service.isBusinessDay('2026-01-03')).resolves.toBe(false);
    await expect(service.isBusinessDay('2026-01-05')).resolves.toBe(true);
  });

  it('evaluates business days against the persisted holidays', async () => {
    const service = new CalendarService(
      WEEKENDS,
      new FakeHolidays(['2026-01-05']),
      fakeTime('2026-05-10'),
    );

    await expect(service.isBusinessDay('2026-01-05')).resolves.toBe(false);
    await expect(service.nextBusinessDay('2026-01-05')).resolves.toBe(
      '2026-01-06',
    );
  });

  it('truncates to the month end and then shifts to a business day', async () => {
    const service = new CalendarService(
      WEEKENDS,
      new FakeHolidays(['2026-02-27', '2026-02-28']),
      fakeTime('2026-05-10'),
    );

    await expect(service.resolveScheduledDate(2026, 2, 31)).resolves.toBe(
      '2026-03-02',
    );
  });
});
