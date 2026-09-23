export const ENGINE_DOWN_TOLERANCE_MINUTES = 'ENGINE_DOWN_TOLERANCE_MINUTES';

export const DEFAULT_ENGINE_DOWN_TOLERANCE_MINUTES = 15;

export function readEngineDownToleranceMinutes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.ENGINE_DOWN_TOLERANCE_MINUTES?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_ENGINE_DOWN_TOLERANCE_MINUTES;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected a positive number, got: ${raw}`);
  }
  return value;
}
