import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { buildProviderOperationId } from '../gateway/provider-operation-id';
import { PG_POOL } from '../health/health.constants';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import { EXECUTION_TIMEOUT } from './execution-timeout';
import { MAX_ATTEMPTS } from './charge-executor.types';
import type {
  AttemptSettlement,
  AttemptStartResult,
  ChargeExecutorPort,
} from './charge-executor.types';

const LOCK_INTENT = `
SELECT status, amount, currency
FROM billing_intents
WHERE id = $1
FOR UPDATE
`;

const LAST_AUTO_SEQ = `
SELECT COALESCE(MAX(auto_seq), 0)::int AS "attemptNo"
FROM payment_attempts
WHERE billing_intent_id = $1 AND trigger = 'AUTO'
`;

const INSERT_ATTEMPT = `
INSERT INTO payment_attempts
  (billing_intent_id, trigger, auto_seq, provider_operation_id, status, deadline_at)
VALUES ($1, 'AUTO', $2, $3, 'IN_FLIGHT', now() + ($4 * interval '1 millisecond'))
RETURNING id
`;

const MARK_IN_FLIGHT = `
UPDATE billing_intents
SET status = 'IN_FLIGHT'
WHERE id = $1
`;

const FINISH_ATTEMPT = `
UPDATE payment_attempts
SET status = $2, error_type = $3, finished_at = now()
WHERE id = $1 AND status = 'IN_FLIGHT'
`;

const SETTLE_INTENT = `
UPDATE billing_intents
SET status = $2, settled_at = CASE WHEN $3 THEN now() ELSE settled_at END
WHERE id = $1
`;

const SETTLEMENT_TARGETS = {
  SUCCEEDED: {
    attemptStatus: 'SUCCEEDED',
    intentStatus: 'SUCCEEDED',
    settled: true,
  },
  FAILED: {
    attemptStatus: 'FAILED',
    intentStatus: 'SCHEDULED',
    settled: false,
  },
  UNKNOWN: {
    attemptStatus: 'UNKNOWN',
    intentStatus: 'UNKNOWN',
    settled: false,
  },
} as const;

@Injectable()
export class ChargeExecutorRepository implements ChargeExecutorPort {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EXECUTION_TIMEOUT) private readonly timeoutMs: number,
  ) {}

  async startAttempt(billingIntentId: string): Promise<AttemptStartResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{
        status: BillingIntentStatus;
        amount: string;
        currency: string;
      }>(LOCK_INTENT, [billingIntentId]);

      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_FOUND', billingIntentId };
      }

      const { status } = locked.rows[0];

      if (status === 'IN_FLIGHT') {
        await client.query('ROLLBACK');
        return { outcome: 'ALREADY_IN_FLIGHT', billingIntentId };
      }

      if (status !== 'SCHEDULED') {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_SCHEDULED', billingIntentId, status };
      }

      const last = await client.query<{ attemptNo: number }>(LAST_AUTO_SEQ, [
        billingIntentId,
      ]);
      const attemptNo = last.rows[0].attemptNo + 1;

      if (attemptNo > MAX_ATTEMPTS) {
        await client.query('ROLLBACK');
        return {
          outcome: 'ATTEMPTS_EXHAUSTED',
          billingIntentId,
          attempts: last.rows[0].attemptNo,
        };
      }

      const providerOperationId = buildProviderOperationId(
        billingIntentId,
        attemptNo,
      );
      const inserted = await client.query<{ id: string }>(INSERT_ATTEMPT, [
        billingIntentId,
        attemptNo,
        providerOperationId,
        this.timeoutMs,
      ]);
      await client.query(MARK_IN_FLIGHT, [billingIntentId]);

      await client.query('COMMIT');

      return {
        outcome: 'STARTED',
        billingIntentId,
        attemptId: inserted.rows[0].id,
        attemptNo,
        providerOperationId,
        amount: Number(locked.rows[0].amount),
        currency: locked.rows[0].currency,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async settleAttempt(
    billingIntentId: string,
    attemptId: string,
    settlement: AttemptSettlement,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{ status: BillingIntentStatus }>(
        LOCK_INTENT,
        [billingIntentId],
      );

      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }

      if (locked.rows[0].status === 'SUCCEEDED') {
        await client.query('ROLLBACK');
        return;
      }

      const target = SETTLEMENT_TARGETS[settlement.outcome];
      const errorType =
        settlement.outcome === 'FAILED' ? settlement.errorType : null;

      await client.query(FINISH_ATTEMPT, [
        attemptId,
        target.attemptStatus,
        errorType,
      ]);
      await client.query(SETTLE_INTENT, [
        billingIntentId,
        target.intentStatus,
        target.settled,
      ]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
