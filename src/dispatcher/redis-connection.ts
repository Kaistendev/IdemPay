import type { ConnectionOptions } from 'bullmq';

export function bullRedisOptions(
  env: NodeJS.ProcessEnv = process.env,
): ConnectionOptions {
  const url = new URL(env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}
