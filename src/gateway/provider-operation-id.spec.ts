import { buildProviderOperationId } from './provider-operation-id';

const INTENT = '3f1d9b7e-6a4c-4f0b-9e2a-1c5d7e8f9a0b';

describe('buildProviderOperationId', () => {
  it('is stable for the same attempt', () => {
    expect(buildProviderOperationId(INTENT, 1)).toBe(
      buildProviderOperationId(INTENT, 1),
    );
  });

  it('differs across attempts of the same intent', () => {
    expect(buildProviderOperationId(INTENT, 1)).not.toBe(
      buildProviderOperationId(INTENT, 2),
    );
  });

  it('differs across intents', () => {
    expect(buildProviderOperationId(INTENT, 1)).not.toBe(
      buildProviderOperationId('other-intent', 1),
    );
  });

  it('rejects an empty intent id', () => {
    expect(() => buildProviderOperationId('', 1)).toThrow(/billingIntentId/);
    expect(() => buildProviderOperationId('   ', 1)).toThrow(/billingIntentId/);
  });

  it('rejects an invalid attempt number', () => {
    expect(() => buildProviderOperationId(INTENT, 0)).toThrow(/attemptNo/);
    expect(() => buildProviderOperationId(INTENT, 1.5)).toThrow(/attemptNo/);
  });
});
