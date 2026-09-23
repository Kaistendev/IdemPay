import type {
  BillingIntentStatus,
  SubscriptionFrequency,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';

export interface SchedulableSubscription {
  id: string;
  amount: number;
  currency: string;
  frequency: SubscriptionFrequency;
  anchorDate: string;
  status: SubscriptionStatus;
}

export interface SchedulerIntentSnapshot {
  id: string;
  subscriptionId: string;
  billingCycle: string;
  scheduleDate: string;
  amount: number;
  currency: string;
  status: BillingIntentStatus;
  omittedReason: 'ENGINE_DOWN' | 'OVERLAP' | null;
}

export interface SchedulerIntentExposure {
  billingCycle: string;
  status: BillingIntentStatus;
}

export interface BillingSchedulerRepositoryPort {
  listActiveSubscriptions(): Promise<SchedulableSubscription[]>;
  listExistingIntents(
    subscriptionId: string,
  ): Promise<SchedulerIntentExposure[]>;
  scheduleIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null>;
  omitEngineDownIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null>;
  omitOverlapIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null>;
}
