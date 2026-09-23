export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type CalendarCadence = 'daily' | 'weekly' | 'monthly' | 'annual';

export interface CalendarConfig {
  nonBusinessWeekdays: readonly Weekday[];
}

export interface NonBusinessDaySource {
  listHolidays(): Promise<string[]>;
}
