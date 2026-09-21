import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { buildProviderOperationId } from '../gateway/provider-operation-id';
import { PG_POOL } from '../health/health.constants';
import type {
  BillingIntentStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';
import { EXECUTION_TIMEOUT } from './execution-timeout';
import { MAX_ATTEMPTS } from './charge-executor.types';
import type {
  AttemptSettlement,
  AttemptStartResult,
  ChargeExecutorPort,
} from './charge-executor.types';

const LOCK_INTENT = `
SELECT i.status, i.amount, i.currency,
       i.subscription_id AS "subscriptionId",
       s.status AS "subscriptionStatus",
       (i.status = 'RETRY_PENDING' AND i.next_attempt_at <= now()) AS "retryDue"
FROM billing_intents i
JOIN subscriptions s ON s.id = i.subscription_id
WHERE i.id = $1
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
SET status = $2,
    settled_at = CASE WHEN $3 THEN now() ELSE settled_at END,
    unknown_since = CASE WHEN $4 THEN COALESCE(unknown_since, now()) ELSE unknown_since END,
    next_attempt_at = CASE WHEN $5 THEN $6 ELSE next_attempt_at END
WHERE id = $1
`;

const CANCEL_SUBSCRIPTION = `
UPDATE subscriptions
SET status = 'CANCELLED', cancelled_at = now()
WHERE id = $1 AND status <> 'CANCELLED'
`;

const OMIT_SUBSCRIPTION_INTENTS = `
UPDATE billing_intents
SET status = 'OMITTED',
    omitted_reason = 'SUBSCRIPTION_CANCELLED',
    settled_at = now()
WHERE subscription_id = $1
  AND status IN ('SCHEDULED', 'RETRY_PENDING')
`;

const APPEND_CANCELLATION_EVENT = `
INSERT INTO notifications (type, aggregate_id, payload)
VALUES ('CancellationEvent', $1, $2)
`;

const SETTLEMENT_TARGETS = {
  SUCCEEDED: {
    attemptStatus: 'SUCCEEDED',
    intentStatus: 'SUCCEEDED',
    settled: true,
    unknownSince: false,
    nextAttemptAt: false,
  },
  RETRY_PENDING: {
    attemptStatus: 'FAILED',
    intentStatus: 'RETRY_PENDING',
    settled: false,
    unknownSince: false,
    nextAttemptAt: true,
  },
  FAILED_FINAL: {
    attemptStatus: 'FAILED',
    intentStatus: 'FAILED_FINAL',
    settled: true,
    unknownSince: false,
    nextAttemptAt: false,
  },
  UNKNOWN: {
    attemptStatus: 'UNKNOWN',
    intentStatus: 'UNKNOWN',
    settled: false,
    unknownSince: true,
    nextAttemptAt: false,
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
        retryDue: boolean;
        subscriptionId: string;
        subscriptionStatus: SubscriptionStatus;
      }>(LOCK_INTENT, [billingIntentId]);

      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_FOUND', billingIntentId };
      }

      const { status, retryDue } = locked.rows[0];

      if (status === 'IN_FLIGHT') {
        await client.query('ROLLBACK');
        return { outcome: 'ALREADY_IN_FLIGHT', billingIntentId };
      }

      if (status === 'RETRY_PENDING' && retryDue !== true) {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_SCHEDULED', billingIntentId, status };
      }

      if (status !== 'SCHEDULED' && status !== 'RETRY_PENDING') {
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

      const locked = await client.query<{
        status: BillingIntentStatus;
        subscriptionId: string;
        subscriptionStatus: SubscriptionStatus;
      }>(LOCK_INTENT, [billingIntentId]);

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
        settlement.outcome === 'RETRY_PENDING' ||
        settlement.outcome === 'FAILED_FINAL'
          ? settlement.errorType
          : null;
      const nextAttemptAt =
        settlement.outcome === 'RETRY_PENDING'
          ? settlement.nextAttemptAt
          : null;

      await client.query(FINISH_ATTEMPT, [
        attemptId,
        target.attemptStatus,
        errorType,
      ]);
      await client.query(SETTLE_INTENT, [
        billingIntentId,
        target.intentStatus,
        target.settled,
        target.unknownSince,
        target.nextAttemptAt,
        nextAttemptAt,
      ]);

      if (settlement.outcome === 'FAILED_FINAL') {
        const { subscriptionId, subscriptionStatus } = locked.rows[0];
        if (subscriptionStatus !== 'CANCELLED') {
          const cancelled = await client.query(CANCEL_SUBSCRIPTION, [
            subscriptionId,
          ]);
          if ((cancelled.rowCount ?? 0) > 0) {
            await client.query(OMIT_SUBSCRIPTION_INTENTS, [subscriptionId]);
            await client.query(APPEND_CANCELLATION_EVENT, [
              subscriptionId,
              {
                subscriptionId,
                billingIntentId,
                reason: 'FAILED_FINAL',
              },
            ]);
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
