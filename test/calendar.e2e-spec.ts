import { Test, TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { CalendarService } from '../src/calendar/calendar.service';
import { PG_POOL } from '../src/health/health.constants';

const HOLIDAYS = ['2030-06-10', '2030-06-11'];

describe('calendar (e2e)', () => {
  let moduleRef: TestingModule;
  let pool: Pool;
  let calendar: CalendarService;

  const cleanup = async () => {
    await pool.query(
      'DELETE FROM calendar_non_business_days WHERE date = ANY($1::date[])',
      [HOLIDAYS],
    );
  };

  const declareHoliday = async (date: string) => {
    await pool.query(
      `INSERT INTO calendar_non_business_days (date, reason)
       VALUES ($1::date, 'e2e holiday')
       ON CONFLICT (date) DO UPDATE SET reason = EXCLUDED.reason`,
      [date],
    );
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    pool = moduleRef.get<Pool>(PG_POOL);
    calendar = moduleRef.get(CalendarService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await moduleRef.close();
  });

  it('covers the month end and business day rules end to end', async () => {
    await expect(calendar.resolveScheduledDate(2026, 2, 31)).resolves.toBe(
      '2026-03-02',
    );
    await expect(calendar.isBusinessDay('2030-06-09')).resolves.toBe(false);
    await expect(calendar.isBusinessDay('2030-06-10')).resolves.toBe(true);
  });

  it('honours a persisted non-business day', async () => {
    await declareHoliday(HOLIDAYS[0]);

    await expect(calendar.isBusinessDay(HOLIDAYS[0])).resolves.toBe(false);
    await expect(calendar.nextBusinessDay(HOLIDAYS[0])).resolves.toBe(
      '2030-06-11',
    );
  });

  it('skips consecutive persisted holidays', async () => {
    await declareHoliday(HOLIDAYS[0]);
    await declareHoliday(HOLIDAYS[1]);

    await expect(calendar.nextBusinessDay(HOLIDAYS[0])).resolves.toBe(
      '2030-06-12',
    );
  });
});
