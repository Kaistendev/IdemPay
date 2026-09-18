import { nextBillingDate } from './next-billing-date';

describe('nextBillingDate', () => {
  it('returns the anchor while it is still in the future', () => {
    expect(nextBillingDate('2026-06-01', 'monthly', '2026-05-10')).toBe(
      '2026-06-01',
    );
    expect(nextBillingDate('2026-06-01', 'daily', '2026-05-10')).toBe(
      '2026-06-01',
    );
  });

  it('returns the anchor when it is today', () => {
    expect(nextBillingDate('2026-05-10', 'monthly', '2026-05-10')).toBe(
      '2026-05-10',
    );
  });

  it('advances daily cadence from the anchor without drift', () => {
    expect(nextBillingDate('2026-01-01', 'daily', '2026-01-10')).toBe(
      '2026-01-10',
    );
  });

  it('advances weekly cadence from the anchor without drift', () => {
    expect(nextBillingDate('2026-01-01', 'weekly', '2026-01-08')).toBe(
      '2026-01-08',
    );
    expect(nextBillingDate('2026-01-01', 'weekly', '2026-01-09')).toBe(
      '2026-01-15',
    );
  });

  it('keeps the anchor day when the destination month has it', () => {
    expect(nextBillingDate('2026-01-10', 'monthly', '2026-02-10')).toBe(
      '2026-02-10',
    );
    expect(nextBillingDate('2026-01-10', 'monthly', '2026-02-11')).toBe(
      '2026-03-10',
    );
  });

  it('truncates the day 31 to the last day of the destination month', () => {
    expect(nextBillingDate('2026-01-31', 'monthly', '2026-02-01')).toBe(
      '2026-02-28',
    );
    expect(nextBillingDate('2026-01-31', 'monthly', '2026-03-01')).toBe(
      '2026-03-31',
    );
    expect(nextBillingDate('2026-03-31', 'monthly', '2026-04-01')).toBe(
      '2026-04-30',
    );
  });

  it('truncates Feb 29 to the last day of February in non-leap years', () => {
    expect(nextBillingDate('2024-02-29', 'annual', '2026-01-01')).toBe(
      '2026-02-28',
    );
    expect(nextBillingDate('2024-02-29', 'annual', '2028-01-01')).toBe(
      '2028-02-29',
    );
  });
});
