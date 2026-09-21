import type {
  BillingIntentStatus,
  PaymentAttemptStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';

export type {
  BillingIntentStatus,
  PaymentAttemptStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';

export type TransitionAggregate =
  'billingIntent' | 'paymentAttempt' | 'subscription';

export type BillingIntentTransition = readonly [
  BillingIntentStatus,
  BillingIntentStatus,
];

export type PaymentAttemptTransition = readonly [
  PaymentAttemptStatus,
  PaymentAttemptStatus,
];

export type SubscriptionTransition = readonly [
  SubscriptionStatus,
  SubscriptionStatus,
];

export type AnyTransition =
  BillingIntentTransition | PaymentAttemptTransition | SubscriptionTransition;

export interface IllegalTransition {
  aggregate: TransitionAggregate;
  from: string;
  to: string;
}
