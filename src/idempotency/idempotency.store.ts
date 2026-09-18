import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../health/health.constants';
import {
  IDEMPOTENCY_TTL_MS,
  idempotencyRecordKey,
} from './idempotency.constants';
import {
  BeginIdempotencyResult,
  IdempotencyRecord,
  IdempotencySettlement,
  IdempotencyState,
  IdempotencyStorePort,
} from './idempotency.types';

const BEGIN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'payloadHash', ARGV[1],
  'state', 'PROCESSING',
  'createdAt', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const SETTLE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], 'state') ~= 'PROCESSING' then
  return -1
end
redis.call('HSET', KEYS[1],
  'state', 'SETTLED',
  'response', ARGV[1],
  'billingIntentRef', ARGV[2],
  'settledAt', ARGV[3])
return 1
`;

@Injectable()
export class IdempotencyStore implements IdempotencyStorePort {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async begin(
    key: string,
    payloadHash: string,
  ): Promise<BeginIdempotencyResult> {
    const recordKey = idempotencyRecordKey(key);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const acquired =
        Number(
          await this.redis.eval(
            BEGIN_SCRIPT,
            1,
            recordKey,
            payloadHash,
            new Date().toISOString(),
            String(IDEMPOTENCY_TTL_MS),
          ),
        ) === 1;

      const record = await this.read(key);
      if (record) {
        return { acquired, record };
      }
    }

    throw new Error(`Unable to register the idempotency record for ${key}`);
  }

  async settle(
    key: string,
    settlement: IdempotencySettlement,
  ): Promise<IdempotencyRecord | null> {
    const settled =
      Number(
        await this.redis.eval(
          SETTLE_SCRIPT,
          1,
          idempotencyRecordKey(key),
          JSON.stringify(settlement.response),
          settlement.billingIntentRef ?? '',
          new Date().toISOString(),
        ),
      ) === 1;

    return settled ? this.read(key) : null;
  }

  async read(key: string): Promise<IdempotencyRecord | null> {
    const fields = await this.redis.hgetall(idempotencyRecordKey(key));
    if (Object.keys(fields).length === 0) {
      return null;
    }

    const response = fields.response;

    return {
      key,
      payloadHash: fields.payloadHash ?? '',
      state: (fields.state ?? 'PROCESSING') as IdempotencyState,
      response: response
        ? (JSON.parse(response) as IdempotencyRecord['response'])
        : null,
      billingIntentRef: fields.billingIntentRef
        ? fields.billingIntentRef
        : null,
      createdAt: fields.createdAt ?? '',
      settledAt: fields.settledAt ? fields.settledAt : null,
    };
  }

  async ttlMillis(key: string): Promise<number> {
    return this.redis.pttl(idempotencyRecordKey(key));
  }
}
