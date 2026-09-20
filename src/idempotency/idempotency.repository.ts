import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { Clock } from '../common/time/clock';
import { CLOCK } from '../common/time/clock';
import { PG_POOL } from '../health/health.constants';
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_TTL_MS,
} from './idempotency.constants';
import type {
  IdempotencyOperationType,
  IdempotencyRegistration,
  IdempotencySettlement,
} from './idempotency.types';

interface IdempotencyOperationRow {
  id: string;
  generation: number;
  operation_type: IdempotencyOperationType;
  payload_hash: string;
  status: 'PROCESSING' | 'SETTLED';
  response_status: number | null;
  response_body: unknown;
  billing_intent_id: string | null;
  created_at: Date;
  expires_at: Date;
  lease_expires_at: Date | null;
  settled_at: Date | null;
}

const LATEST_OPERATION = `
SELECT id, generation, operation_type, payload_hash, status,
       response_status, response_body, billing_intent_id,
       created_at, expires_at, lease_expires_at, settled_at
FROM idempotency_operations
WHERE key = $1
ORDER BY generation DESC
LIMIT 1
FOR UPDATE
`;

const REGISTER_OPERATION = `
INSERT INTO idempotency_operations
  (key, generation, operation_type, payload_hash, status,
   response_status, response_body, billing_intent_id,
   created_at, expires_at, lease_expires_at, settled_at)
VALUES ($1, $2, $3, $4, 'PROCESSING', NULL, NULL, NULL, $5, $6, $7, NULL)
ON CONFLICT (key, generation) DO NOTHING
RETURNING id
`;

const REFRESH_LEASE = `
UPDATE idempotency_operations
SET lease_expires_at = $2
WHERE id = $1
`;

const SETTLE_OPERATION = `
UPDATE idempotency_operations
SET status = 'SETTLED',
    response_status = $3,
    response_body = $4::jsonb,
    billing_intent_id = $5,
    settled_at = $6,
    lease_expires_at = NULL
WHERE key = $1 AND generation = $2 AND status = 'PROCESSING'
`;

@Injectable()
export class IdempotencyRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async registerOrGet(
    key: string,
    payloadHash: string,
    operationType: IdempotencyOperationType,
  ): Promise<IdempotencyRegistration> {
    const now = this.clock.now();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      let row = await this.lockLatest(client, key);

      if (!row) {
        if (
          await this.register(client, key, payloadHash, operationType, 1, now)
        ) {
          await client.query('COMMIT');
          return { outcome: 'NEW', generation: 1 };
        }
        row = await this.lockLatest(client, key);
        if (!row) {
          throw new Error(`Idempotency registration lost the race for ${key}`);
        }
      }

      if (now.getTime() > row.expires_at.getTime()) {
        const generation = row.generation + 1;
        if (
          await this.register(
            client,
            key,
            payloadHash,
            operationType,
            generation,
            now,
          )
        ) {
          await client.query('COMMIT');
          return { outcome: 'NEW', generation };
        }
        row = await this.lockLatest(client, key);
        if (!row) {
          throw new Error(`Idempotency registration lost the race for ${key}`);
        }
      }

      const registration = await this.classify(client, row, payloadHash, now);
      await client.query('COMMIT');
      return registration;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async settle(
    client: PoolClient,
    key: string,
    generation: number,
    settlement: IdempotencySettlement,
  ): Promise<boolean> {
    const { rowCount } = await client.query(SETTLE_OPERATION, [
      key,
      generation,
      settlement.response.statusCode,
      settlement.response.body,
      settlement.billingIntentRef,
      this.clock.now(),
    ]);
    return rowCount === 1;
  }

  private async lockLatest(
    client: PoolClient,
    key: string,
  ): Promise<IdempotencyOperationRow | null> {
    const { rows } = await client.query<IdempotencyOperationRow>(
      LATEST_OPERATION,
      [key],
    );
    return rows[0] ?? null;
  }

  private async register(
    client: PoolClient,
    key: string,
    payloadHash: string,
    operationType: IdempotencyOperationType,
    generation: number,
    now: Date,
  ): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
    const leaseExpiresAt = new Date(now.getTime() + IDEMPOTENCY_LEASE_MS);
    const { rowCount } = await client.query(REGISTER_OPERATION, [
      key,
      generation,
      operationType,
      payloadHash,
      now,
      expiresAt,
      leaseExpiresAt,
    ]);
    return rowCount === 1;
  }

  private async classify(
    client: PoolClient,
    row: IdempotencyOperationRow,
    payloadHash: string,
    now: Date,
  ): Promise<IdempotencyRegistration> {
    if (row.payload_hash !== payloadHash) {
      return {
        outcome: 'MISMATCH',
        storedPayloadHash: row.payload_hash,
      };
    }

    if (row.status === 'SETTLED') {
      return {
        outcome: 'REPLAY',
        response: {
          statusCode: row.response_status ?? 0,
          body: row.response_body,
        },
        billingIntentId: row.billing_intent_id,
      };
    }

    const leaseExpiresAt = row.lease_expires_at;
    if (leaseExpiresAt && now.getTime() > leaseExpiresAt.getTime()) {
      await client.query(REFRESH_LEASE, [
        row.id,
        new Date(now.getTime() + IDEMPOTENCY_LEASE_MS),
      ]);
      return { outcome: 'RETAKE', generation: row.generation };
    }

    const leaseRemainingSeconds = leaseExpiresAt
      ? Math.max(
          0,
          Math.ceil((leaseExpiresAt.getTime() - now.getTime()) / 1000),
        )
      : 0;
    return { outcome: 'IN_FLIGHT', leaseRemainingSeconds };
  }
}
