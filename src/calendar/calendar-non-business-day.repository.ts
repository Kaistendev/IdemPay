import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { NonBusinessDaySource } from './calendar.types';

const LIST_HOLIDAYS = `
SELECT to_char(date, 'YYYY-MM-DD') AS date
FROM calendar_non_business_days
ORDER BY date
`;

@Injectable()
export class CalendarNonBusinessDayRepository implements NonBusinessDaySource {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listHolidays(): Promise<string[]> {
    const { rows } = await this.pool.query<{ date: string }>(LIST_HOLIDAYS);
    return rows.map((row) => row.date);
  }
}
