import { createSubscriptionSchema } from './subscription.schema';

const VALID = {
  amount: 1500,
  currency: 'USD',
  frequency: 'monthly',
  startDate: '2026-05-10',
  timezone: 'UTC',
};

describe('createSubscriptionSchema', () => {
  it('accepts an amount expressed as an integer in minor units', () => {
    const result = createSubscriptionSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects a decimal amount', () => {
    const result = createSubscriptionSchema.safeParse({
      ...VALID,
      amount: 15.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.path.join('.')),
      ).toContain('amount');
    }
  });

  it('accepts an ISO 4217 currency code', () => {
    const result = createSubscriptionSchema.safeParse({
      ...VALID,
      currency: 'EUR',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-ISO 4217 code even if it is three uppercase letters', () => {
    const result = createSubscriptionSchema.safeParse({
      ...VALID,
      currency: 'ZZZ',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.path.join('.')),
      ).toContain('currency');
    }
  });

  it('rejects a lowercase currency code', () => {
    const result = createSubscriptionSchema.safeParse({
      ...VALID,
      currency: 'usd',
    });
    expect(result.success).toBe(false);
  });
});
