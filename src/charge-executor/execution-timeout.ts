export const EXECUTION_TIMEOUT = 'EXECUTION_TIMEOUT';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;

export function readExecutionTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.EXECUTION_TIMEOUT_MS?.trim();
  if (!configured || configured.length === 0) {
    return DEFAULT_EXECUTION_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`Invalid EXECUTION_TIMEOUT_MS: ${configured}`);
  }
  return timeoutMs;
}
