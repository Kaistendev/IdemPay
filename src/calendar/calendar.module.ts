import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { HealthModule } from '../health/health.module';
import { CalendarNonBusinessDayRepository } from './calendar-non-business-day.repository';
import { CALENDAR_CONFIG, NON_BUSINESS_DAY_SOURCE } from './calendar.constants';
import { readCalendarConfig } from './calendar.config';
import { CalendarService } from './calendar.service';

@Module({
  imports: [CommonModule, HealthModule],
  providers: [
    CalendarNonBusinessDayRepository,
    CalendarService,
    {
      provide: NON_BUSINESS_DAY_SOURCE,
      useExisting: CalendarNonBusinessDayRepository,
    },
    { provide: CALENDAR_CONFIG, useFactory: () => readCalendarConfig() },
  ],
  exports: [CalendarService, CALENDAR_CONFIG, NON_BUSINESS_DAY_SOURCE],
})
export class CalendarModule {}
