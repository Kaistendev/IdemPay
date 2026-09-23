import type {
  BillingIntentStatus,
  PaymentAttemptStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';

export const BILLING_INTENT_STATES: readonly BillingIntentStatus[] = [
  'SCHEDULED',
  'IN_FLIGHT',
  'RETRY_PENDING',
  'SUCCEEDED',
  'FAILED_FINAL',
  'UNKNOWN',
  'OMITTED',
];

export const PAYMENT_ATTEMPT_STATES: readonly PaymentAttemptStatus[] = [
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
];

export const SUBSCRIPTION_STATES: readonly SubscriptionStatus[] = [
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
];

/**
 * Transiciones permitidas de Billing Intent (§5.1 spec).
 * `SUCCEEDED` no admite salida (INV-07); `FAILED_FINAL`, `RETRY_PENDING`
 * y `OMITTED` solo admiten las salidas listadas.
 * El reprocess (RF-29) reabre una intent terminal hacia `IN_FLIGHT`.
 */
export const ALLOWED_BILLING_INTENT_TRANSITIONS: ReadonlyArray<
  readonly [BillingIntentStatus, BillingIntentStatus]
> = [
  ['SCHEDULED', 'IN_FLIGHT'],
  ['SCHEDULED', 'OMITTED'],
  ['IN_FLIGHT', 'SUCCEEDED'],
  ['IN_FLIGHT', 'FAILED_FINAL'],
  ['IN_FLIGHT', 'UNKNOWN'],
  ['IN_FLIGHT', 'RETRY_PENDING'],
  ['RETRY_PENDING', 'IN_FLIGHT'],
  ['RETRY_PENDING', 'OMITTED'],
  ['UNKNOWN', 'IN_FLIGHT'],
  ['UNKNOWN', 'SUCCEEDED'],
  ['UNKNOWN', 'RETRY_PENDING'],
  ['UNKNOWN', 'OMITTED'],
  ['FAILED_FINAL', 'IN_FLIGHT'],
];

/**
 * Transiciones permitidas de Payment Attempt (§5.2 spec).
 * `SUCCEEDED`, `FAILED` y `UNKNOWN` no admiten salida.
 */
export const ALLOWED_PAYMENT_ATTEMPT_TRANSITIONS: ReadonlyArray<
  readonly [PaymentAttemptStatus, PaymentAttemptStatus]
> = [
  ['IN_FLIGHT', 'SUCCEEDED'],
  ['IN_FLIGHT', 'FAILED'],
  ['IN_FLIGHT', 'UNKNOWN'],
];

/**
 * Transiciones permitidas de Subscription (§5.3 spec).
 * `CANCELLED` no admite salida (INV-05).
 */
export const ALLOWED_SUBSCRIPTION_TRANSITIONS: ReadonlyArray<
  readonly [SubscriptionStatus, SubscriptionStatus]
> = [
  ['ACTIVE', 'PAUSED'],
  ['ACTIVE', 'CANCELLED'],
  ['PAUSED', 'ACTIVE'],
  ['PAUSED', 'CANCELLED'],
];
