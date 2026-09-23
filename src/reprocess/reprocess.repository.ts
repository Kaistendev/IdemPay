import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { EXECUTION_TIMEOUT } from '../charge-executor/execution-timeout';
import { PG_POOL } from '../health/health.constants';
import type {
  BillingIntentStatus,
  SubscriptionStatus,
} from '../subscriptions/subscriptions.types';
import type {
  ReprocessCandidate,
  ReprocessIntentView,
  ReprocessPort,
  ReprocessSettlement,
  ReprocessStartResult,
} from './reprocess.types';

const LOAD_CANDIDATE = `
SELECT i.id,
       i.subscription_id AS "subscriptionId",
       i.status,
       (SELECT a.provider_operation_id
        FROM payment_attempts a
        WHERE a.billing_intent_id = i.id
        ORDER BY a.started_at DESC
        LIMIT 1) AS "providerOperationId"
FROM billing_intents i
WHERE i.subscription_id = $1 AND i.billing_cycle = $2
`;

const CLOSE_AS_SUCCEEDED = `
UPDATE billing_intents
SET status = 'SUCCEEDED', settled_at = now()
WHERE id = $1 AND status = 'UNKNOWN'
RETURNING id
`;

const LOCK_MANUAL_INTENT = `
SELECT i.status, i.amount, i.currency
FROM billing_intents i
WHERE i.id = $1
FOR UPDATE
`;

const MANUAL_ATTEMPT_SEQ = `
SELECT COUNT(*)::int AS "manualSeq"
FROM payment_attempts
WHERE billing_intent_id = $1
`;

const INSERT_MANUAL_ATTEMPT = `
INSERT INTO payment_attempts
  (billing_intent_id, trigger, auto_seq, provider_operation_id, status, deadline_at)
VALUES ($1, 'MANUAL', NULL, $2, 'IN_FLIGHT', now() + ($3 * interval '1 millisecond'))
RETURNING id
`;

const MARK_IN_FLIGHT = `
UPDATE billing_intents
SET status = 'IN_FLIGHT', settled_at = NULL
WHERE id = $1
`;

const LOCK_SETTLE = `
SELECT i.status,
       i.subscription_id AS "subscriptionId",
       s.status AS "subscriptionStatus"
FROM billing_intents i
JOIN subscriptions s ON s.id = i.subscription_id
WHERE i.id = $1
FOR UPDATE
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

const FIND_INTENT = `
SELECT id,
       subscription_id AS "subscriptionId",
       billing_cycle AS "billingCycle",
       schedule_date::text AS "scheduleDate",
       amount,
       currency,
       status,
       omitted_reason AS "omittedReason",
       settled_at AS "settledAt"
FROM billing_intents
WHERE subscription_id = $1 AND billing_cycle = $2
`;

const SETTLE_MANUAL_TARGETS = {
  SUCCEEDED: {
    attemptStatus: 'SUCCEEDED',
    intentStatus: 'SUCCEEDED',
    settled: true,
    unknownSince: false,
  },
  FAILED_FINAL: {
    attemptStatus: 'FAILED',
    intentStatus: 'FAILED_FINAL',
    settled: true,
    unknownSince: false,
  },
  UNKNOWN: {
    attemptStatus: 'UNKNOWN',
    intentStatus: 'UNKNOWN',
    settled: false,
    unknownSince: true,
  },
} as const;

interface CandidateRow {
  id: string;
  subscriptionId: string;
  status: BillingIntentStatus;
  providerOperationId: string | null;
}

interface IntentViewRow {
  id: string;
  subscriptionId: string;
  billingCycle: string;
  scheduleDate: string;
  amount: string;
  currency: string;
  status: BillingIntentStatus;
  omittedReason: string | null;
  settledAt: Date | null;
}

@Injectable()
export class ReprocessRepository implements ReprocessPort {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EXECUTION_TIMEOUT) private readonly timeoutMs: number = 60_000,
  ) {}

  async loadCandidate(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessCandidate | null> {
    const { rows } = await this.pool.query<CandidateRow>(LOAD_CANDIDATE, [
      subscriptionId,
      billingCycle,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      status: row.status,
      providerOperationId: row.providerOperationId,
    };
  }

  async closeVerificationAsSucceeded(
    billingIntentId: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const closed = await client.query<{ id: string }>(CLOSE_AS_SUCCEEDED, [
        billingIntentId,
      ]);

      if (closed.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async startManualAttempt(
    billingIntentId: string,
  ): Promise<ReprocessStartResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{
        status: BillingIntentStatus;
        amount: string;
        currency: string;
      }>(LOCK_MANUAL_INTENT, [billingIntentId]);

      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_FOUND', billingIntentId };
      }

      const { status, amount, currency } = locked.rows[0];

      if (status !== 'UNKNOWN' && status !== 'FAILED_FINAL') {
        await client.query('ROLLBACK');
        return { outcome: 'NOT_ELIGIBLE', billingIntentId };
      }

      const counted = await client.query<{ manualSeq: number }>(
        MANUAL_ATTEMPT_SEQ,
        [billingIntentId],
      );
      const manualSeq = counted.rows[0].manualSeq + 1;
      const providerOperationId = `${billingIntentId}:manual:${manualSeq}`;

      const inserted = await client.query<{ id: string }>(
        INSERT_MANUAL_ATTEMPT,
        [billingIntentId, providerOperationId, this.timeoutMs],
      );
      await client.query(MARK_IN_FLIGHT, [billingIntentId]);

      await client.query('COMMIT');

      return {
        outcome: 'STARTED',
        billingIntentId,
        attemptId: inserted.rows[0].id,
        providerOperationId,
        amount: Number(amount),
        currency,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (isInFlightUniqueViolation(error)) {
        return { outcome: 'ALREADY_IN_FLIGHT', billingIntentId };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async settleManualAttempt(
    billingIntentId: string,
    attemptId: string,
    settlement: ReprocessSettlement,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const locked = await client.query<{
        status: BillingIntentStatus;
        subscriptionId: string;
        subscriptionStatus: SubscriptionStatus;
      }>(LOCK_SETTLE, [billingIntentId]);

      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }

      if (locked.rows[0].status === 'SUCCEEDED') {
        await client.query('ROLLBACK');
        return;
      }

      const target = SETTLE_MANUAL_TARGETS[settlement.outcome];
      const errorType =
        settlement.outcome === 'FAILED_FINAL' ? settlement.errorType : null;

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
        false,
        null,
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

  async findIntent(
    subscriptionId: string,
    billingCycle: string,
  ): Promise<ReprocessIntentView | null> {
    const { rows } = await this.pool.query<IntentViewRow>(FIND_INTENT, [
      subscriptionId,
      billingCycle,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      billingCycle: row.billingCycle,
      scheduleDate: row.scheduleDate,
      amount: Number(row.amount),
      currency: row.currency,
      status: row.status,
      omittedReason: row.omittedReason,
      settledAt: row.settledAt ? new Date(row.settledAt) : null,
    };
  }
}

function isInFlightUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'payment_attempts_in_flight_unique'
  );
}
