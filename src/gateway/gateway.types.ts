export const PAYMENT_SCENARIOS = [
  'SUCCESS',
  'DECLINED',
  'TIMEOUT',
  'AMBIGUOUS',
  'PROVIDER_ERROR',
] as const;

export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

export type ChargeOutcome =
  'SUCCEEDED' | 'DECLINED' | 'TIMEOUT' | 'AMBIGUOUS' | 'PROVIDER_ERROR';

export type VerificationResult = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface ChargeRequest {
  providerOperationId: string;
  amount: number;
  currency: string;
}

export interface ChargeResult {
  providerOperationId: string;
  outcome: ChargeOutcome;
}

export interface IPaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  verify(providerOperationId: string): Promise<VerificationResult>;
}
