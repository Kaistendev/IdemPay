import type { ChargeOutcome } from '../gateway/gateway.types';
import type { PaymentError } from '../gateway/payment-error';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';

export const MAX_ATTEMPTS = 5;

export type AttemptStartOutcome =
  | 'STARTED'
  | 'NOT_FOUND'
  | 'ALREADY_IN_FLIGHT'
  | 'NOT_SCHEDULED'
  | 'ATTEMPTS_EXHAUSTED';

export interface StartedAttempt {
  outcome: 'STARTED';
  billingIntentId: string;
  attemptId: string;
  attemptNo: number;
  providerOperationId: string;
  amount: number;
  currency: string;
}

export interface NotFoundAttempt {
  outcome: 'NOT_FOUND';
  billingIntentId: string;
}

export interface AlreadyInFlightAttempt {
  outcome: 'ALREADY_IN_FLIGHT';
  billingIntentId: string;
}

export interface NotScheduledAttempt {
  outcome: 'NOT_SCHEDULED';
  billingIntentId: string;
  status: BillingIntentStatus;
}

export interface ExhaustedAttempt {
  outcome: 'ATTEMPTS_EXHAUSTED';
  billingIntentId: string;
  attempts: number;
}

export type AttemptStartResult =
  | StartedAttempt
  | NotFoundAttempt
  | AlreadyInFlightAttempt
  | NotScheduledAttempt
  | ExhaustedAttempt;

export type SettlementOutcome =
  'SUCCEEDED' | 'RETRY_PENDING' | 'FAILED_FINAL' | 'UNKNOWN';

export type AttemptSettlement =
  | { outcome: 'SUCCEEDED' }
  | { outcome: 'RETRY_PENDING'; errorType: PaymentError; nextAttemptAt: Date }
  | { outcome: 'FAILED_FINAL'; errorType: PaymentError }
  | { outcome: 'UNKNOWN' };

export interface ChargeExecutorPort {
  startAttempt(billingIntentId: string): Promise<AttemptStartResult>;
  settleAttempt(
    billingIntentId: string,
    attemptId: string,
    settlement: AttemptSettlement,
  ): Promise<void>;
}

export interface SucceededExecution {
  outcome: 'SUCCEEDED';
  billingIntentId: string;
  attemptId: string;
  attemptNo: number;
  providerOperationId: string;
  chargeOutcome: ChargeOutcome;
}

export interface RetryPendingExecution {
  outcome: 'RETRY_PENDING';
  billingIntentId: string;
  attemptId: string;
  attemptNo: number;
  providerOperationId: string;
  chargeOutcome: ChargeOutcome;
  errorType: PaymentError;
  nextAttemptAt: Date;
}

export interface FinalFailedExecution {
  outcome: 'FAILED_FINAL';
  billingIntentId: string;
  attemptId: string;
  attemptNo: number;
  providerOperationId: string;
  chargeOutcome: ChargeOutcome;
  errorType: PaymentError;
}

export interface UnknownExecution {
  outcome: 'UNKNOWN';
  billingIntentId: string;
  attemptId: string;
  attemptNo: number;
  providerOperationId: string;
  chargeOutcome: ChargeOutcome;
}

export interface NotStartedExecution {
  outcome: 'NOT_STARTED';
  billingIntentId: string;
  reason: Exclude<AttemptStartOutcome, 'STARTED'>;
}

export type ChargeExecutionResult =
  | SucceededExecution
  | RetryPendingExecution
  | FinalFailedExecution
  | UnknownExecution
  | NotStartedExecution;
