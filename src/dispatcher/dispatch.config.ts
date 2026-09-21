export const CHARGE_DISPATCH_INTERVAL = 'CHARGE_DISPATCH_INTERVAL';
export const DISPATCH_BATCH_SIZE = 'DISPATCH_BATCH_SIZE';

export const DEFAULT_CHARGE_DISPATCH_INTERVAL_MS = 1_000;
export const DEFAULT_DISPATCH_BATCH_SIZE = 100;

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number, got: ${raw}`);
  }
  return value;
}

export function readChargeDispatchIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveNumber(
    env.CHARGE_DISPATCH_INTERVAL_MS,
    DEFAULT_CHARGE_DISPATCH_INTERVAL_MS,
  );
}

export function readDispatchBatchSize(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveNumber(
    env.DISPATCH_BATCH_SIZE,
    DEFAULT_DISPATCH_BATCH_SIZE,
  );
}
