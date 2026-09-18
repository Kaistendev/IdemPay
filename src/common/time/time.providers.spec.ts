import { Test } from '@nestjs/testing';
import { CommonModule } from '../common.module';
import { CLOCK } from './clock';
import type { Clock } from './clock';
import { SCHEDULING_TIMEZONE } from './scheduling-timezone';
import { TimeService } from './time.service';

describe('CommonModule time providers', () => {
  it('provides a system clock and the scheduling zone', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
    }).compile();

    const clock = moduleRef.get<Clock>(CLOCK);
    const timeZone = moduleRef.get<string>(SCHEDULING_TIMEZONE);

    expect(clock.now()).toBeInstanceOf(Date);
    expect(typeof timeZone).toBe('string');
    expect(timeZone.length).toBeGreaterThan(0);

    await moduleRef.close();
  });

  it('lets tests override the clock deterministically', async () => {
    const frozen = new Date('2030-01-01T00:00:00.000Z');
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
    })
      .overrideProvider(CLOCK)
      .useValue({ now: () => frozen })
      .compile();

    const service = moduleRef.get(TimeService);

    expect(service.now()).toBe(frozen);
    expect(service.today()).toBe('2030-01-01');

    await moduleRef.close();
  });
});
