export const VERIFICATION_SWEEP_INTERVAL = 'VERIFICATION_SWEEP_INTERVAL';

export const DEFAULT_VERIFICATION_SWEEP_INTERVAL_MS = 5_000;

export function readVerificationSweepIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.VERIFICATION_SWEEP_INTERVAL_MS?.trim();
  if (!configured || configured.length === 0) {
    return DEFAULT_VERIFICATION_SWEEP_INTERVAL_MS;
  }

  const intervalMs = Number(configured);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid VERIFICATION_SWEEP_INTERVAL_MS: ${configured}`);
  }
  return intervalMs;
}
