import { billingCycleChargeParamsSchema } from './billing-cycle.schema';

describe('billingCycleChargeParamsSchema', () => {
  it('accepts a valid subscription id and nominal cycle date', () => {
    const result = billingCycleChargeParamsSchema.safeParse({
      id: 'c6f1ad3f-1b4e-4b6a-9c2d-8e12f3456789',
      cycle: '2026-09-10',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a malformed subscription id', () => {
    const result = billingCycleChargeParamsSchema.safeParse({
      id: 'not-a-uuid',
      cycle: '2026-09-10',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a cycle that is not a real calendar date', () => {
    const result = billingCycleChargeParamsSchema.safeParse({
      id: 'c6f1ad3f-1b4e-4b6a-9c2d-8e12f3456789',
      cycle: '2026-02-30',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a cycle with a non ISO-8601 format', () => {
    const result = billingCycleChargeParamsSchema.safeParse({
      id: 'c6f1ad3f-1b4e-4b6a-9c2d-8e12f3456789',
      cycle: '10/05/2026',
    });

    expect(result.success).toBe(false);
  });
});
