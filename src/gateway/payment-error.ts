import type { ChargeOutcome } from './gateway.types';

export const RETRYABLE_PAYMENT_ERRORS = [
  'PROVIDER_ERROR',
  'TEMPORARY_UNAVAILABLE',
] as const;

export const AMBIGUOUS_PAYMENT_ERRORS = ['TIMEOUT', 'AMBIGUOUS'] as const;

export const NON_RETRYABLE_PAYMENT_ERRORS = [
  'DECLINED',
  'INVALID_PAYMENT',
  'INVALID_AMOUNT',
  'CANCELLED_SUBSCRIPTION',
] as const;

export const PAYMENT_ERRORS = [
  ...RETRYABLE_PAYMENT_ERRORS,
  ...AMBIGUOUS_PAYMENT_ERRORS,
  ...NON_RETRYABLE_PAYMENT_ERRORS,
] as const;

export type PaymentError = (typeof PAYMENT_ERRORS)[number];

export type ErrorDisposition = 'RETRYABLE' | 'AMBIGUOUS' | 'NON_RETRYABLE';

const DISPOSITIONS: Record<PaymentError, ErrorDisposition> = {
  PROVIDER_ERROR: 'RETRYABLE',
  TEMPORARY_UNAVAILABLE: 'RETRYABLE',
  TIMEOUT: 'AMBIGUOUS',
  AMBIGUOUS: 'AMBIGUOUS',
  DECLINED: 'NON_RETRYABLE',
  INVALID_PAYMENT: 'NON_RETRYABLE',
  INVALID_AMOUNT: 'NON_RETRYABLE',
  CANCELLED_SUBSCRIPTION: 'NON_RETRYABLE',
};

export function isPaymentError(value: string): value is PaymentError {
  return (PAYMENT_ERRORS as readonly string[]).includes(value);
}

export function classifyPaymentError(error: string): ErrorDisposition {
  if (!isPaymentError(error)) {
    throw new Error(`Unclassified payment error: ${error}`);
  }
  return DISPOSITIONS[error];
}

export function isRetryablePaymentError(error: string): boolean {
  return classifyPaymentError(error) === 'RETRYABLE';
}

export function errorTypeForOutcome(
  outcome: ChargeOutcome,
): PaymentError | null {
  switch (outcome) {
    case 'SUCCEEDED':
    case 'AMBIGUOUS':
      return null;
    case 'DECLINED':
      return 'DECLINED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'PROVIDER_ERROR':
      return 'PROVIDER_ERROR';
  }
}
