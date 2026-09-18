import { ChargesService } from './charges.service';

describe('ChargesService', () => {
  it('creates a charge and counts a single execution per call', () => {
    const service = new ChargesService();

    const result = service.create({ amount: 100, currency: 'USD' });

    expect(result).toEqual({
      id: 'chg_1',
      status: 'CREATED',
      amount: 100,
      currency: 'USD',
    });
    expect(service.executionCount()).toBe(1);
  });

  it('increments the execution count for every created charge', () => {
    const service = new ChargesService();

    service.create({ amount: 100, currency: 'USD' });
    service.create({ amount: 200, currency: 'USD' });

    expect(service.executionCount()).toBe(2);
  });
});
