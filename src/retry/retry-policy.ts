import { classifyPaymentError } from '../gateway/payment-error';
import type { PaymentError } from '../gateway/payment-error';

export type RetryDecision = 'RETRY_PENDING' | 'FAILED_FINAL';

export const DEFAULT_MAX_RETRIES = 5;

export function decideRetry(
  errorType: PaymentError,
  attemptNo: number,
  maxAttempts: number = DEFAULT_MAX_RETRIES,
): RetryDecision {
  if (attemptNo >= maxAttempts) {
    return 'FAILED_FINAL';
  }
  return classifyPaymentError(errorType) === 'NON_RETRYABLE'
    ? 'FAILED_FINAL'
    : 'RETRY_PENDING';
}
