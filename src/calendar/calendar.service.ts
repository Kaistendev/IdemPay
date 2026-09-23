import { Inject, Injectable } from '@nestjs/common';
import { TimeService } from '../common/time/time.service';
import {
  currentCycleDate as computeCurrentCycleDate,
  cycleDateAt as computeCycleDateAt,
  isBusinessDay,
  isOverdueByTolerance as computeIsOverdueByTolerance,
  nextBusinessDay,
  nextCycleDate,
  resolveScheduledDate,
} from './calendar';
import { CALENDAR_CONFIG, NON_BUSINESS_DAY_SOURCE } from './calendar.constants';
import type {
  CalendarCadence,
  CalendarConfig,
  NonBusinessDaySource,
} from './calendar.types';

@Injectable()
export class CalendarService {
  constructor(
    @Inject(CALENDAR_CONFIG) private readonly config: CalendarConfig,
    @Inject(NON_BUSINESS_DAY_SOURCE)
    private readonly source: NonBusinessDaySource,
    private readonly time: TimeService,
  ) {}

  today(): string {
    return this.time.today();
  }

  async isBusinessDay(date: string): Promise<boolean> {
    return isBusinessDay(date, this.config, await this.loadHolidays());
  }

  async nextBusinessDay(date: string): Promise<string> {
    return nextBusinessDay(date, this.config, await this.loadHolidays());
  }

  async resolveScheduledDate(
    year: number,
    month: number,
    anchorDay: number,
  ): Promise<string> {
    return resolveScheduledDate(
      year,
      month,
      anchorDay,
      this.config,
      await this.loadHolidays(),
    );
  }

  nextBillingDate(anchorDate: string, cadence: CalendarCadence, today: string) {
    return nextCycleDate(anchorDate, cadence, today);
  }

  currentCycleDate(
    anchorDate: string,
    cadence: CalendarCadence,
    today: string,
  ): string | null {
    return computeCurrentCycleDate(anchorDate, cadence, today);
  }

  cycleDateAt(
    anchorDate: string,
    cadence: CalendarCadence,
    index: number,
  ): string {
    return computeCycleDateAt(anchorDate, cadence, index);
  }

  isOverdueByTolerance(
    scheduleDate: string,
    today: string,
    toleranceMinutes: number,
  ): boolean {
    return computeIsOverdueByTolerance(scheduleDate, today, toleranceMinutes);
  }

  private async loadHolidays(): Promise<ReadonlySet<string>> {
    return new Set(await this.source.listHolidays());
  }
}
