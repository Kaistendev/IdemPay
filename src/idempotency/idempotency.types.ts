export type IdempotencyOperationType =
  | 'SUBSCRIPTION_CREATE'
  | 'SUBSCRIPTION_PAUSE'
  | 'SUBSCRIPTION_RESUME'
  | 'SUBSCRIPTION_CANCEL'
  | 'BILLING_CYCLE_CHARGE'
  | 'BILLING_INTENT_REPROCESS';

export type IdempotencyRegistration =
  | { outcome: 'NEW'; generation: number }
  | {
      outcome: 'REPLAY';
      response: IdempotencyResponse;
      billingIntentId: string | null;
    }
  | { outcome: 'IN_FLIGHT'; leaseRemainingSeconds: number }
  | { outcome: 'MISMATCH'; storedPayloadHash: string }
  | { outcome: 'RETAKE'; generation: number };

export interface IdempotencyResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencySettlement {
  response: IdempotencyResponse;
  billingIntentRef: string | null;
}
