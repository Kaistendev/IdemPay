import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  ChargeVerifierPort,
  UnknownChargeCandidate,
  VerificationResolution,
  VerificationSettlement,
} from './charge-verification.types';

const FIND_UNKNOWN = `
SELECT DISTINCT ON (i.id)
       i.id AS "billingIntentId",
       a.provider_operation_id AS "providerOperationId",
       a.auto_seq AS "attemptNo",
       s.status AS "subscriptionStatus",
       i.verify_count AS "verifyCount",
       i.unknown_since AS "unknownSince"
FROM billing_intents i
JOIN payment_attempts a ON a.billing_intent_id = i.id
JOIN subscriptions s ON s.id = i.subscription_id
WHERE i.status = 'UNKNOWN'
  AND a.status = 'UNKNOWN'
  AND i.needs_manual_review = false
  AND (i.next_verify_at IS NULL OR i.next_verify_at <= $1)
ORDER BY i.id, a.started_at DESC
`;

const SETTLE_AS_SUCCEEDED = `
UPDATE billing_intents
SET status = 'SUCCEEDED', settled_at = now()
WHERE id = $1 AND status = 'UNKNOWN'
`;

const SETTLE_AS_RETRY_PENDING = `
UPDATE billing_intents
SET status = 'RETRY_PENDING', next_attempt_at = $2
WHERE id = $1 AND status = 'UNKNOWN'
`;

const SETTLE_AS_OMITTED = `
UPDATE billing_intents
SET status = 'OMITTED', omitted_reason = $2, settled_at = now()
WHERE id = $1 AND status = 'UNKNOWN'
`;

const INCREMENT_VERIFY_COUNT = `
UPDATE billing_intents
SET verify_count = verify_count + 1,
    next_verify_at = $2,
    needs_manual_review = $3
WHERE id = $1 AND status = 'UNKNOWN' AND needs_manual_review = false
`;

const MARK_MANUAL_REVIEW = `
UPDATE billing_intents
SET needs_manual_review = true, next_verify_at = NULL
WHERE id = $1 AND status = 'UNKNOWN'
`;

@Injectable()
export class ChargeVerificationRepository implements ChargeVerifierPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findUnknown(cutoff: Date): Promise<UnknownChargeCandidate[]> {
    const { rows } = await this.pool.query<UnknownChargeCandidate>(
      FIND_UNKNOWN,
      [cutoff],
    );
    return rows;
  }

  async settleVerification(
    billingIntentId: string,
    settlement: VerificationSettlement,
  ): Promise<void> {
    if (settlement.outcome === 'SUCCEEDED') {
      await this.pool.query(SETTLE_AS_SUCCEEDED, [billingIntentId]);
      return;
    }
    if (settlement.outcome === 'RETRY_PENDING') {
      await this.pool.query(SETTLE_AS_RETRY_PENDING, [
        billingIntentId,
        settlement.nextAttemptAt,
      ]);
      return;
    }
    await this.pool.query(SETTLE_AS_OMITTED, [
      billingIntentId,
      settlement.omittedReason,
    ]);
  }

  async markVerificationUnknown(
    billingIntentId: string,
    resolution: VerificationResolution,
  ): Promise<void> {
    await this.pool.query(INCREMENT_VERIFY_COUNT, [
      billingIntentId,
      resolution.nextVerifyAt,
      resolution.needsManualReview,
    ]);
  }

  async markManualReview(billingIntentId: string): Promise<void> {
    await this.pool.query(MARK_MANUAL_REVIEW, [billingIntentId]);
  }
}
