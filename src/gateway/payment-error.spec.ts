import type { ChargeOutcome } from './gateway.types';
import { MockPaymentAdapter } from './mock-payment.adapter';
import { PAYMENT_SCENARIOS } from './gateway.types';
import {
  AMBIGUOUS_PAYMENT_ERRORS,
  NON_RETRYABLE_PAYMENT_ERRORS,
  PAYMENT_ERRORS,
  RETRYABLE_PAYMENT_ERRORS,
  classifyPaymentError,
  errorTypeForOutcome,
  isRetryablePaymentError,
} from './payment-error';
import type { PaymentError } from './payment-error';

describe('payment error catalog', () => {
  it('declares the retryable errors from RF-20 (no TIMEOUT)', () => {
    expect(RETRYABLE_PAYMENT_ERRORS).toEqual([
      'PROVIDER_ERROR',
      'TEMPORARY_UNAVAILABLE',
    ]);
  });

  it('declares the ambiguous errors (D6) - not retryable without verify', () => {
    expect(AMBIGUOUS_PAYMENT_ERRORS).toEqual(['TIMEOUT', 'AMBIGUOUS']);
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
      [
        ...RETRYABLE_PAYMENT_ERRORS,
        ...AMBIGUOUS_PAYMENT_ERRORS,
        ...NON_RETRYABLE_PAYMENT_ERRORS,
      ].sort(),
    );
  });

  it.each(RETRYABLE_PAYMENT_ERRORS)('classifies %s as retryable', (error) => {
    expect(classifyPaymentError(error)).toBe('RETRYABLE');
    expect(isRetryablePaymentError(error)).toBe(true);
  });

  it.each(AMBIGUOUS_PAYMENT_ERRORS)(
    'classifies %s as ambiguous (not retryable)',
    (error) => {
      expect(classifyPaymentError(error)).toBe('AMBIGUOUS');
      expect(isRetryablePaymentError(error)).toBe(false);
    },
  );

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

  it('TIMEOUT never triggers a retry without verify (D6)', () => {
    expect(isRetryablePaymentError('TIMEOUT')).toBe(false);
    expect(classifyPaymentError('TIMEOUT')).toBe('AMBIGUOUS');
  });

  it('AMBIGUOUS never triggers a retry without verify (D6)', () => {
    expect(isRetryablePaymentError('AMBIGUOUS')).toBe(false);
    expect(classifyPaymentError('AMBIGUOUS')).toBe('AMBIGUOUS');
  });

  it('PROVIDER_ERROR remains retryable', () => {
    expect(isRetryablePaymentError('PROVIDER_ERROR')).toBe(true);
  });

  it('TEMPORARY_UNAVAILABLE remains retryable', () => {
    expect(isRetryablePaymentError('TEMPORARY_UNAVAILABLE')).toBe(true);
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

  it('TIMEOUT mapped error is not retryable (D6)', () => {
    const error = errorTypeForOutcome('TIMEOUT');
    expect(error).toBe('TIMEOUT');
    expect(isRetryablePaymentError(error!)).toBe(false);
  });
});
