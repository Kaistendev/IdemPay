import { PAYMENT_SCENARIOS } from './gateway.types';
import type { PaymentScenario } from './gateway.types';

export const PAYMENT_SCENARIO = 'PAYMENT_SCENARIO';

export const DEFAULT_PAYMENT_SCENARIO: PaymentScenario = 'SUCCESS';

export function isValidPaymentScenario(
  value: string,
): value is PaymentScenario {
  return (PAYMENT_SCENARIOS as readonly string[]).includes(value);
}

export function readPaymentScenario(
  env: NodeJS.ProcessEnv = process.env,
): PaymentScenario {
  const configured = env.MOCK_PAYMENT_SCENARIO?.trim();
  if (!configured || configured.length === 0) {
    return DEFAULT_PAYMENT_SCENARIO;
  }

  const scenario = configured.toUpperCase();
  if (!isValidPaymentScenario(scenario)) {
    throw new Error(`Invalid MOCK_PAYMENT_SCENARIO: ${configured}`);
  }
  return scenario;
}
