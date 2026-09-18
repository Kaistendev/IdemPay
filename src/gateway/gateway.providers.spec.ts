import { Test } from '@nestjs/testing';
import { PAYMENT_GATEWAY } from './gateway.constants';
import { GatewayModule } from './gateway.module';
import { MockPaymentAdapter } from './mock-payment.adapter';
import {
  DEFAULT_PAYMENT_SCENARIO,
  PAYMENT_SCENARIO,
  readPaymentScenario,
} from './payment-scenario';
import type { IPaymentGateway } from './gateway.types';

describe('GatewayModule providers', () => {
  it('exposes the mock adapter as the payment gateway', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    }).compile();

    const gateway = moduleRef.get<IPaymentGateway>(PAYMENT_GATEWAY);
    const scenario = moduleRef.get<string>(PAYMENT_SCENARIO);

    expect(gateway).toBeInstanceOf(MockPaymentAdapter);
    expect(scenario).toBe(DEFAULT_PAYMENT_SCENARIO);

    await moduleRef.close();
  });

  it('lets tests override the scenario deterministically', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    })
      .overrideProvider(PAYMENT_SCENARIO)
      .useValue('DECLINED')
      .compile();

    const gateway = moduleRef.get<IPaymentGateway>(PAYMENT_GATEWAY);
    const result = await gateway.charge({
      providerOperationId: 'po-1',
      amount: 100,
      currency: 'USD',
    });

    expect(result.outcome).toBe('DECLINED');

    await moduleRef.close();
  });
});

describe('readPaymentScenario', () => {
  it('defaults to SUCCESS', () => {
    expect(readPaymentScenario({})).toBe('SUCCESS');
  });

  it('reads and normalizes a configured scenario', () => {
    expect(readPaymentScenario({ MOCK_PAYMENT_SCENARIO: 'ambiguous' })).toBe(
      'AMBIGUOUS',
    );
  });

  it('rejects an unknown scenario', () => {
    expect(() =>
      readPaymentScenario({ MOCK_PAYMENT_SCENARIO: 'EXPLODE' }),
    ).toThrow(/Invalid MOCK_PAYMENT_SCENARIO/);
  });
});
