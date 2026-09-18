import type { ChargeOutcome } from './gateway.types';
import { MockPaymentAdapter } from './mock-payment.adapter';
import { PAYMENT_SCENARIOS } from './gateway.types';
import {
  NON_RETRYABLE_PAYMENT_ERRORS,
  PAYMENT_ERRORS,
  RETRYABLE_PAYMENT_ERRORS,
  classifyPaymentError,
  errorTypeForOutcome,
  isRetryablePaymentError,
} from './payment-error';
import type { PaymentError } from './payment-error';

describe('payment error catalog', () => {
  it('declares the retryable errors from RF-20', () => {
    expect(RETRYABLE_PAYMENT_ERRORS).toEqual([
      'TIMEOUT',
      'PROVIDER_ERROR',
      'TEMPORARY_UNAVAILABLE',
    ]);
  });

  it('declares the non-retryable errors from RF-20', () => {
    expect(NON_RETRYABLE_PAYMENT_ERRORS).toEqual([
      'DECLINED',
      'INVALID_PAYMENT',
      'INVALID_AMOUNT',
      'CANCELLED_SUBSCRIPTION',
    ]);
  });

  it('exposes every declared error in the catalog', () => {
    expect([...PAYMENT_ERRORS].sort()).toEqual(
      [...RETRYABLE_PAYMENT_ERRORS, ...NON_RETRYABLE_PAYMENT_ERRORS].sort(),
    );
  });

  it.each(RETRYABLE_PAYMENT_ERRORS)('classifies %s as retryable', (error) => {
    expect(classifyPaymentError(error)).toBe('RETRYABLE');
    expect(isRetryablePaymentError(error)).toBe(true);
  });

  it.each(NON_RETRYABLE_PAYMENT_ERRORS)(
    'classifies %s as non-retryable',
    (error) => {
      expect(classifyPaymentError(error)).toBe('NON_RETRYABLE');
      expect(isRetryablePaymentError(error)).toBe(false);
    },
  );

  it('rejects an explicit but unknown error', () => {
    expect(() => classifyPaymentError('STRIPE_WEIRD')).toThrow(
      /Unclassified payment error/,
    );
  });
});

describe('errorTypeForOutcome', () => {
  it('maps the mock error outcomes to catalog entries', () => {
    expect(errorTypeForOutcome('DECLINED')).toBe('DECLINED');
    expect(errorTypeForOutcome('TIMEOUT')).toBe('TIMEOUT');
    expect(errorTypeForOutcome('PROVIDER_ERROR')).toBe('PROVIDER_ERROR');
  });

  it('has no error type for success or ambiguous outcomes', () => {
    expect(errorTypeForOutcome('SUCCEEDED')).toBeNull();
    expect(errorTypeForOutcome('AMBIGUOUS')).toBeNull();
  });

  it('classifies every outcome produced by the mock', async () => {
    for (const scenario of PAYMENT_SCENARIOS) {
      const adapter = new MockPaymentAdapter(scenario);
      const { outcome } = await adapter.charge({
        providerOperationId: `po-${scenario}`,
        amount: 100,
        currency: 'USD',
      });

      const error = errorTypeForOutcome(outcome);
      if (outcome === 'SUCCEEDED' || outcome === 'AMBIGUOUS') {
        expect(error).toBeNull();
      } else {
        expect(error).not.toBeNull();
        expect(PAYMENT_ERRORS).toContain(error as PaymentError);
      }
    }
  });

  it('treats the mock failure outcomes as explicitly classified', () => {
    const outcomes: ChargeOutcome[] = [
      'DECLINED',
      'TIMEOUT',
      'PROVIDER_ERROR',
      'SUCCEEDED',
      'AMBIGUOUS',
    ];

    for (const outcome of outcomes) {
      const error = errorTypeForOutcome(outcome);
      if (error !== null) {
        expect(() => classifyPaymentError(error)).not.toThrow();
      }
    }
  });
});
