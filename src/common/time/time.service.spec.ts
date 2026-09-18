import { TimeService } from './time.service';
import type { Clock } from './clock';

class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return this.instant;
  }
}

describe('TimeService', () => {
  const instant = new Date('2026-09-17T02:30:00.000Z');

  it('returns the injected instant', () => {
    const service = new TimeService(new FixedClock(instant), 'UTC');

    expect(service.now()).toBe(instant);
  });

  it('exposes the configured scheduling zone', () => {
    const service = new TimeService(new FixedClock(instant), 'Asia/Tokyo');

    expect(service.schedulingTimeZone()).toBe('Asia/Tokyo');
  });

  it('derives today from the clock and the scheduling zone', () => {
    const buenosAires = new TimeService(
      new FixedClock(instant),
      'America/Argentina/Buenos_Aires',
    );
    const tokyo = new TimeService(new FixedClock(instant), 'Asia/Tokyo');
    const utc = new TimeService(new FixedClock(instant), 'UTC');

    expect(buenosAires.today()).toBe('2026-09-16');
    expect(tokyo.today()).toBe('2026-09-17');
    expect(utc.today()).toBe('2026-09-17');
  });
});
