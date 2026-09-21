import type { SubscriptionStatus } from '../subscriptions/subscriptions.types';

export type OmittedReason =
  'ENGINE_DOWN' | 'SUBSCRIPTION_PAUSED' | 'SUBSCRIPTION_CANCELLED' | 'OVERLAP';

export interface UnknownChargeCandidate {
  billingIntentId: string;
  providerOperationId: string;
  attemptNo: number;
  subscriptionStatus: SubscriptionStatus;
  verifyCount: number;
  unknownSince: Date;
}

export interface VerificationResolution {
  nextVerifyAt: Date | null;
  needsManualReview: boolean;
}

export type VerificationSettlement =
  | { outcome: 'SUCCEEDED' }
  | { outcome: 'RETRY_PENDING'; nextAttemptAt: Date }
  | { outcome: 'OMITTED'; omittedReason: OmittedReason };

export interface ChargeVerifierPort {
  findUnknown(cutoff: Date): Promise<UnknownChargeCandidate[]>;
  settleVerification(
    billingIntentId: string,
    settlement: VerificationSettlement,
  ): Promise<void>;
  markVerificationUnknown(
    billingIntentId: string,
    resolution: VerificationResolution,
  ): Promise<void>;
  markManualReview(billingIntentId: string): Promise<void>;
}
