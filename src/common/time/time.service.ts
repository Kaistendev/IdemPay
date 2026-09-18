import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from './clock';
import type { Clock } from './clock';
import { isoDateInTimeZone } from './date-format';
import { SCHEDULING_TIMEZONE } from './scheduling-timezone';

@Injectable()
export class TimeService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SCHEDULING_TIMEZONE) private readonly timeZone: string,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  schedulingTimeZone(): string {
    return this.timeZone;
  }

  today(): string {
    return isoDateInTimeZone(this.clock.now(), this.timeZone);
  }
}
