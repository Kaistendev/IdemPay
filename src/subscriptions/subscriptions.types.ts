import type { CreateSubscriptionRequest } from './subscription.schema';

export type { CreateSubscriptionRequest } from './subscription.schema';

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED';

export type SubscriptionFrequency = 'daily' | 'weekly' | 'monthly' | 'annual';

export interface SubscriptionRecord {
  id: string;
  amount: string;
  currency: string;
  frequency: SubscriptionFrequency;
  startDate: string;
  timezone: string;
  status: SubscriptionStatus;
  createdAt: Date;
}

export interface SubscriptionResponse {
  id: string;
  amount: number;
  currency: string;
  frequency: SubscriptionFrequency;
  startDate: string;
  timezone: string;
  status: SubscriptionStatus;
  createdAt: string;
}

export interface SubscriptionsRepositoryPort {
  insert(input: CreateSubscriptionRequest): Promise<SubscriptionRecord>;
}

export type BillingIntentStatus =
  | 'SCHEDULED'
  | 'IN_FLIGHT'
  | 'RETRY_PENDING'
  | 'SUCCEEDED'
  | 'FAILED_FINAL'
  | 'UNKNOWN'
  | 'OMITTED';

export type PaymentAttemptStatus =
  'IN_FLIGHT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface SubscriptionDetailRecord {
  id: string;
  amount: string;
  currency: string;
  frequency: SubscriptionFrequency;
  startDate: string;
  timezone: string;
  status: SubscriptionStatus;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface BillingIntentHistoryRecord {
  id: string;
  billingCycle: string;
  scheduleDate: string;
  amount: string;
  currency: string;
  status: BillingIntentStatus;
  settledAt: Date | null;
  createdAt: Date;
  omittedReason: string | null;
  needsManualReview: boolean;
}

export interface PaymentAttemptHistoryRecord {
  id: string;
  billingIntentId: string;
  attemptNo: number | null;
  providerOperationId: string;
  status: PaymentAttemptStatus;
  errorType: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  trigger: 'AUTO' | 'MANUAL';
}

export interface SubscriptionHistory {
  subscription: SubscriptionDetailRecord;
  billingIntents: BillingIntentHistoryRecord[];
  paymentAttempts: PaymentAttemptHistoryRecord[];
}

export interface SubscriptionQueriesPort {
  findHistory(id: string): Promise<SubscriptionHistory | null>;
}

export interface PaymentAttemptHistoryResponse {
  id: string;
  attemptNo: number | null;
  providerOperationId: string;
  status: PaymentAttemptStatus;
  errorType: string | null;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'AUTO' | 'MANUAL';
}

export interface BillingIntentHistoryResponse {
  id: string;
  billingCycle: string;
  scheduleDate: string;
  amount: number;
  currency: string;
  status: BillingIntentStatus;
  settledAt: string | null;
  createdAt: string;
  omittedReason: string | null;
  needsManualReview: boolean;
  attempts: PaymentAttemptHistoryResponse[];
}

export interface SubscriptionDetailResponse {
  id: string;
  amount: number;
  currency: string;
  frequency: SubscriptionFrequency;
  startDate: string;
  timezone: string;
  status: SubscriptionStatus;
  nextBillingDate: string | null;
  createdAt: string;
  cancelledAt: string | null;
  billingIntents: BillingIntentHistoryResponse[];
}

export interface SubscriptionCancellationResult {
  id: string;
  status: SubscriptionStatus;
  cancelledAt: Date;
  omittedIntents: number;
}

export interface SubscriptionPauseResult {
  id: string;
  status: 'PAUSED';
  omittedIntents: number;
}

export interface SubscriptionResumeResult {
  id: string;
  status: 'ACTIVE';
}

export interface BillingIntentLiveRecord {
  id: string;
  status: BillingIntentStatus;
}

export interface SubscriptionLifecycleSnapshot {
  id: string;
  status: SubscriptionStatus;
  cancelledAt: Date | null;
  liveIntents: BillingIntentLiveRecord[];
}

export interface SubscriptionLifecyclePort {
  load(id: string): Promise<SubscriptionLifecycleSnapshot | null>;
  applyCancellation(
    id: string,
    omittedIntentIds: readonly string[],
  ): Promise<{ cancelledAt: Date; omittedCount: number } | null>;
  applyPause(
    id: string,
    omittedIntentIds: readonly string[],
  ): Promise<{ omittedCount: number } | null>;
  applyResume(id: string): Promise<{ id: string } | null>;
}
