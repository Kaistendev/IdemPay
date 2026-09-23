import type {
  BillingIntentStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';

export interface BillingCycleChargeParams {
  id: string;
  cycle: string;
}

export interface BillingCycleSubscriptionSnapshot {
  id: string;
  amount: number;
  currency: string;
  status: SubscriptionStatus;
}

export interface BillingIntentSnapshot {
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

export interface BillingCycleChargeResponse {
  id: string;
  subscriptionId: string;
  billingCycle: string;
  scheduleDate: string;
  amount: number;
  currency: string;
  status: BillingIntentStatus;
  omittedReason: string | null;
  settledAt: string | null;
  created: boolean;
}

export type GetOrCreateIntentResult =
  | { intent: BillingIntentSnapshot; created: boolean }
  | { reason: 'SUBSCRIPTION_NOT_ACTIVE' };

export interface BillingCycleRepositoryPort {
  findSubscription(
    id: string,
  ): Promise<BillingCycleSubscriptionSnapshot | null>;
  getOrCreateIntent(input: {
    subscription: BillingCycleSubscriptionSnapshot;
    billingCycle: string;
    idempotencyKey: string;
  }): Promise<GetOrCreateIntentResult>;
  findIntent(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<BillingIntentSnapshot | null>;
}
