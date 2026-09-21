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

describe('MockPaymentAdapter · verify-definitive contract (T31)', () => {
  const charge = (adapter: MockPaymentAdapter, providerOperationId: string) =>
    adapter.charge({
      providerOperationId,
      amount: 1500,
      currency: 'USD',
    });

  it.each(['DECLINED', 'PROVIDER_ERROR'] as const)(
    'rejects a charge with the same id once verify returned FAILED (%s scenario)',
    async (scenario) => {
      const adapter = new MockPaymentAdapter(scenario);

      await charge(adapter, 'po-lost');
      await expect(adapter.verify('po-lost')).resolves.toBe('FAILED');
      expect(adapter.executedChargeCount()).toBe(1);

      const retry = await charge(adapter, 'po-lost');

      expect(retry.outcome).toBe('DECLINED');
      expect(adapter.executedChargeCount()).toBe(1);
      await expect(adapter.verify('po-lost')).resolves.toBe('FAILED');
    },
  );

  it('sequence charge (response lost) → verify FAILED → charge ends rejected with zero extra effective charges', async () => {
    const adapter = new MockPaymentAdapter('PROVIDER_ERROR');

    const first = await charge(adapter, 'po-seq');
    expect(first.outcome).toBe('PROVIDER_ERROR');

    await expect(adapter.verify('po-seq')).resolves.toBe('FAILED');
    const executionsBeforeRetry = adapter.executedChargeCount();

    const replay = await charge(adapter, 'po-seq');

    expect(replay.outcome).toBe('DECLINED');
    expect(adapter.executedChargeCount()).toBe(executionsBeforeRetry);
  });

  it('does not mark a SUCCEEDED operation as rejected', async () => {
    const adapter = new MockPaymentAdapter('SUCCESS');

    await charge(adapter, 'po-ok');
    await expect(adapter.verify('po-ok')).resolves.toBe('SUCCEEDED');

    const replay = await charge(adapter, 'po-ok');

    expect(replay.outcome).toBe('SUCCEEDED');
    expect(adapter.executedChargeCount()).toBe(1);
  });

  it('does not mark a TIMEOUT operation as rejected', async () => {
    const adapter = new MockPaymentAdapter('TIMEOUT');

    await charge(adapter, 'po-timeout');
    await expect(adapter.verify('po-timeout')).resolves.toBe('UNKNOWN');

    const replay = await charge(adapter, 'po-timeout');

    expect(replay.outcome).toBe('TIMEOUT');
    expect(adapter.executedChargeCount()).toBe(1);
    await expect(adapter.verify('po-timeout')).resolves.toBe('UNKNOWN');
  });
});
