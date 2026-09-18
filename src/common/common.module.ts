import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NormalizedErrorFilter } from './errors/normalized-error.filter';
import { CLOCK, SystemClock } from './time/clock';
import {
  readSchedulingTimeZone,
  SCHEDULING_TIMEZONE,
} from './time/scheduling-timezone';
import { TimeService } from './time/time.service';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: NormalizedErrorFilter },
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: SCHEDULING_TIMEZONE,
      useFactory: () => readSchedulingTimeZone(),
    },
    TimeService,
  ],
  exports: [CLOCK, SCHEDULING_TIMEZONE, TimeService],
})
export class CommonModule {}
