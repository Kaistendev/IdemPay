import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY } from './gateway.constants';
import { MockPaymentAdapter } from './mock-payment.adapter';
import { PAYMENT_SCENARIO, readPaymentScenario } from './payment-scenario';

@Module({
  providers: [
    MockPaymentAdapter,
    { provide: PAYMENT_GATEWAY, useExisting: MockPaymentAdapter },
    {
      provide: PAYMENT_SCENARIO,
      useFactory: () => readPaymentScenario(),
    },
  ],
  exports: [PAYMENT_GATEWAY, PAYMENT_SCENARIO, MockPaymentAdapter],
})
export class GatewayModule {}
