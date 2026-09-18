export function buildProviderOperationId(
  billingIntentId: string,
  attemptNo: number,
): string {
  if (!billingIntentId || billingIntentId.trim().length === 0) {
    throw new Error(
      'billingIntentId is required to derive a provider operation id',
    );
  }
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new Error('attemptNo must be a positive integer');
  }

  return `${billingIntentId}:${attemptNo}`;
}
