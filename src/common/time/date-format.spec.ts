import { isoDateInTimeZone } from './date-format';

describe('isoDateInTimeZone', () => {
  const instant = new Date('2026-09-17T02:30:00.000Z');

  it('formats the calendar date in the requested zone', () => {
    expect(isoDateInTimeZone(instant, 'UTC')).toBe('2026-09-17');
  });

  it('shifts the date for zones behind UTC', () => {
    expect(isoDateInTimeZone(instant, 'America/Argentina/Buenos_Aires')).toBe(
      '2026-09-16',
    );
  });

  it('shifts the date for zones ahead of UTC', () => {
    expect(isoDateInTimeZone(instant, 'Asia/Tokyo')).toBe('2026-09-17');
    expect(
      isoDateInTimeZone(new Date('2026-09-17T22:00:00.000Z'), 'Asia/Tokyo'),
    ).toBe('2026-09-18');
  });
});
