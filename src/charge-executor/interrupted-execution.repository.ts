import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import type { Clock } from '../common/time/clock';
import { CLOCK } from '../common/time/clock';
import { PG_POOL } from '../health/health.constants';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import { EXECUTION_TIMEOUT } from './execution-timeout';
import type {
  InterruptedExecutionRecoveryPort,
  RecoveredExecution,
} from './interrupted-execution.types';

const FIND_EXPIRED = `
SELECT a.id AS "attemptId",
       a.billing_intent_id AS "billingIntentId",
       a.provider_operation_id AS "providerOperationId"
FROM payment_attempts a
JOIN billing_intents i ON i.id = a.billing_intent_id
WHERE a.status = 'IN_FLIGHT'
  AND i.status = 'IN_FLIGHT'
  AND a.started_at <= $1
ORDER BY a.started_at
`;

const LOCK_INTENT = `
SELECT status
FROM billing_intents
WHERE id = $1
FOR UPDATE
`;

const LOCK_ATTEMPT = `
SELECT status
FROM payment_attempts
WHERE id = $1
FOR UPDATE
`;

const MARK_ATTEMPT_UNKNOWN = `
UPDATE payment_attempts
SET status = 'UNKNOWN', finished_at = now()
WHERE id = $1 AND status = 'IN_FLIGHT'
`;

const MARK_INTENT_UNKNOWN = `
UPDATE billing_intents
SET status = 'UNKNOWN'
WHERE id = $1 AND status = 'IN_FLIGHT'
`;

@Injectable()
export class InterruptedExecutionRepository implements InterruptedExecutionRecoveryPort {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(EXECUTION_TIMEOUT) private readonly timeoutMs: number,
  ) {}

  async recoverExpired(): Promise<RecoveredExecution[]> {
    const cutoff = new Date(this.clock.now().getTime() - this.timeoutMs);
    const candidates = await this.pool.query<RecoveredExecution>(FIND_EXPIRED, [
      cutoff,
    ]);

    const recovered: RecoveredExecution[] = [];
    for (const candidate of candidates.rows) {
      const result = await this.recoverOne(candidate);
      if (result) {
        recovered.push(result);
      }
    }
    return recovered;
  }

  private async recoverOne(
    candidate: RecoveredExecution,
  ): Promise<RecoveredExecution | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const intent = await client.query<{ status: BillingIntentStatus }>(
        LOCK_INTENT,
        [candidate.billingIntentId],
      );
      if (intent.rows.length === 0 || intent.rows[0].status !== 'IN_FLIGHT') {
        await client.query('ROLLBACK');
        return null;
      }

      const attempt = await client.query<{ status: string }>(LOCK_ATTEMPT, [
        candidate.attemptId,
      ]);
      if (attempt.rows.length === 0 || attempt.rows[0].status !== 'IN_FLIGHT') {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query(MARK_ATTEMPT_UNKNOWN, [candidate.attemptId]);
      await client.query(MARK_INTENT_UNKNOWN, [candidate.billingIntentId]);

      await client.query('COMMIT');
      return candidate;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
