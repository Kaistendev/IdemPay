export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CalendarConfig {
  nonBusinessWeekdays: readonly Weekday[];
}

export interface NonBusinessDaySource {
  listHolidays(): Promise<string[]>;
}
