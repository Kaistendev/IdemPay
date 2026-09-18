import { MockPaymentAdapter } from './mock-payment.adapter';
import type { ChargeOutcome, PaymentScenario } from './gateway.types';

const scenarios: [PaymentScenario, ChargeOutcome][] = [
  ['SUCCESS', 'SUCCEEDED'],
  ['DECLINED', 'DECLINED'],
  ['TIMEOUT', 'TIMEOUT'],
  ['AMBIGUOUS', 'AMBIGUOUS'],
  ['PROVIDER_ERROR', 'PROVIDER_ERROR'],
];

describe('MockPaymentAdapter', () => {
  it.each(scenarios)(
    'charge returns %s as the configured %s scenario',
    async (scenario, expected) => {
      const adapter = new MockPaymentAdapter(scenario);

      const result = await adapter.charge({
        providerOperationId: 'po-1',
        amount: 1500,
        currency: 'USD',
      });

      expect(result).toEqual({
        providerOperationId: 'po-1',
        outcome: expected,
      });
    },
  );

  it('keeps the provider operation identity in the result', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');

    const result = await adapter.charge({
      providerOperationId: 'po-stable',
      amount: 100,
      currency: 'USD',
    });

    expect(result.providerOperationId).toBe('po-stable');
  });

  it('verify reports SUCCEEDED after a successful charge', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');
    await adapter.charge({
      providerOperationId: 'po-success',
      amount: 100,
      currency: 'USD',
    });

    await expect(adapter.verify('po-success')).resolves.toBe('SUCCEEDED');
  });

  it('verify reports FAILED after a declined charge', async () => {
    const adapter = new MockPaymentAdapter('DECLINED');
    await adapter.charge({
      providerOperationId: 'po-declined',
      amount: 100,
      currency: 'USD',
    });

    await expect(adapter.verify('po-declined')).resolves.toBe('FAILED');
  });

  it('executes a provider operation at most once per providerOperationId', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');

    const first = await adapter.charge({
      providerOperationId: 'po-1',
      amount: 1500,
      currency: 'USD',
    });
    const second = await adapter.charge({
      providerOperationId: 'po-1',
      amount: 1500,
      currency: 'USD',
    });

    expect(first.outcome).toBe('SUCCEEDED');
    expect(second.outcome).toBe('SUCCEEDED');
    expect(adapter.executedChargeCount()).toBe(1);
  });

  it('replays the recorded outcome even if the amount changes', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');

    await adapter.charge({
      providerOperationId: 'po-1',
      amount: 1500,
      currency: 'USD',
    });
    const replay = await adapter.charge({
      providerOperationId: 'po-1',
      amount: 9999,
      currency: 'USD',
    });

    expect(replay.outcome).toBe('SUCCEEDED');
    expect(adapter.executedChargeCount()).toBe(1);
  });

  it('executes distinct provider operations independently', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');

    await adapter.charge({
      providerOperationId: 'po-1',
      amount: 1500,
      currency: 'USD',
    });
    await adapter.charge({
      providerOperationId: 'po-2',
      amount: 1500,
      currency: 'USD',
    });

    expect(adapter.executedChargeCount()).toBe(2);
  });

  it('keeps an ambiguous operation UNKNOWN without re-charging it', async () => {
    const adapter = new MockPaymentAdapter('AMBIGUOUS');

    await adapter.charge({
      providerOperationId: 'po-ambiguous',
      amount: 1500,
      currency: 'USD',
    });
    await expect(adapter.verify('po-ambiguous')).resolves.toBe('UNKNOWN');

    await adapter.charge({
      providerOperationId: 'po-ambiguous',
      amount: 1500,
      currency: 'USD',
    });

    expect(adapter.executedChargeCount()).toBe(1);
    await expect(adapter.verify('po-ambiguous')).resolves.toBe('UNKNOWN');
  });

  it('verify reports UNKNOWN for ambiguous or untracked operations', async () => {
    const adapter = new MockPaymentAdapter('AMBIGUOUS');
    await adapter.charge({
      providerOperationId: 'po-ambiguous',
      amount: 100,
      currency: 'USD',
    });

    await expect(adapter.verify('po-ambiguous')).resolves.toBe('UNKNOWN');
    await expect(adapter.verify('po-untracked')).resolves.toBe('UNKNOWN');
  });
});
