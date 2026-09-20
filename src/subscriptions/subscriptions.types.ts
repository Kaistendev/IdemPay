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
}

export interface PaymentAttemptHistoryRecord {
  id: string;
  billingIntentId: string;
  attemptNo: number;
  providerOperationId: string;
  status: PaymentAttemptStatus;
  errorType: string | null;
  startedAt: Date;
  finishedAt: Date | null;
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
  attemptNo: number;
  providerOperationId: string;
  status: PaymentAttemptStatus;
  errorType: string | null;
  startedAt: string;
  finishedAt: string | null;
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

export interface SubscriptionCancellationPort {
  cancel(id: string): Promise<SubscriptionCancellationResult | null>;
}
