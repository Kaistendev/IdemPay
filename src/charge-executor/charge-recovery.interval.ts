export const RECOVERY_SWEEP_INTERVAL = 'RECOVERY_SWEEP_INTERVAL';

export const DEFAULT_RECOVERY_SWEEP_INTERVAL_MS = 30_000;

export function readRecoverySweepIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.RECOVERY_SWEEP_INTERVAL_MS?.trim();
  if (!configured || configured.length === 0) {
    return DEFAULT_RECOVERY_SWEEP_INTERVAL_MS;
  }

  const intervalMs = Number(configured);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid RECOVERY_SWEEP_INTERVAL_MS: ${configured}`);
  }
  return intervalMs;
}
