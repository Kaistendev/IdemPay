import type { PaymentError } from '../gateway/payment-error';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';

export interface ReprocessCandidate {
  id: string;
  subscriptionId: string;
  status: BillingIntentStatus;
  providerOperationId: string | null;
}

export type ReprocessNotEligibleReason =
  'ALREADY_SUCCEEDED' | 'UNKNOWN_UNVERIFIABLE' | 'NOT_ELIGIBLE_STATUS';

export type ReprocessProbeResult =
  | { outcome: 'ELIGIBLE'; billingIntentId: string }
  | {
      outcome: 'NOT_ELIGIBLE';
      billingIntentId: string;
      reason: ReprocessNotEligibleReason;
    }
  | { outcome: 'CLOSED_AS_SUCCEEDED'; billingIntentId: string };

export type ReprocessStartResult =
  | {
      outcome: 'STARTED';
      billingIntentId: string;
      attemptId: string;
      providerOperationId: string;
      amount: number;
      currency: string;
    }
  | { outcome: 'NOT_FOUND'; billingIntentId: string }
  | { outcome: 'ALREADY_IN_FLIGHT'; billingIntentId: string }
  | { outcome: 'NOT_ELIGIBLE'; billingIntentId: string };

export type ReprocessSettlement =
  | { outcome: 'SUCCEEDED' }
  | { outcome: 'FAILED_FINAL'; errorType: PaymentError }
  | { outcome: 'UNKNOWN' };

export interface ReprocessIntentView {
  id: string;
  subscriptionId: string;
  billingCycle: string;
  scheduleDate: string;
  amount: number;
  currency: string;
  status: BillingIntentStatus;
  omittedReason: string | null;
  settledAt: Date | null;
}

export interface ReprocessPort {
  loadCandidate(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessCandidate | null>;
  closeVerificationAsSucceeded(billingIntentId: string): Promise<boolean>;
  startManualAttempt(billingIntentId: string): Promise<ReprocessStartResult>;
  settleManualAttempt(
    billingIntentId: string,
    attemptId: string,
    settlement: ReprocessSettlement,
  ): Promise<void>;
  findIntent(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessIntentView | null>;
}
