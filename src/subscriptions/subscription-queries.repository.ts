import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  BillingIntentHistoryRecord,
  PaymentAttemptHistoryRecord,
  SubscriptionDetailRecord,
  SubscriptionHistory,
  SubscriptionQueriesPort,
} from './subscriptions.types';

const SELECT_SUBSCRIPTION = `
SELECT
  id,
  amount,
  currency,
  frequency,
  anchor_date::text AS "startDate",
  timezone,
  status,
  created_at AS "createdAt",
  cancelled_at AS "cancelledAt"
FROM subscriptions
WHERE id = $1
`;

const SELECT_BILLING_INTENTS = `
SELECT
  id,
  billing_cycle AS "billingCycle",
  schedule_date::text AS "scheduleDate",
  amount,
  currency,
  status,
  settled_at AS "settledAt",
  created_at AS "createdAt"
FROM billing_intents
WHERE subscription_id = $1
ORDER BY billing_cycle ASC, created_at ASC
`;

const SELECT_PAYMENT_ATTEMPTS = `
SELECT
  id,
  billing_intent_id AS "billingIntentId",
  attempt_no AS "attemptNo",
  provider_operation_id AS "providerOperationId",
  status,
  error_type AS "errorType",
  started_at AS "startedAt",
  finished_at AS "finishedAt"
FROM payment_attempts
WHERE billing_intent_id = ANY($1::uuid[])
ORDER BY billing_intent_id ASC, attempt_no ASC
`;

@Injectable()
export class SubscriptionQueriesRepository implements SubscriptionQueriesPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findHistory(id: string): Promise<SubscriptionHistory | null> {
    const subscription = await this.pool.query<SubscriptionDetailRecord>(
      SELECT_SUBSCRIPTION,
      [id],
    );

    if (subscription.rows.length === 0) {
      return null;
    }

    const intents = await this.pool.query<BillingIntentHistoryRecord>(
      SELECT_BILLING_INTENTS,
      [id],
    );

    const intentIds = intents.rows.map((intent) => intent.id);
    const attempts =
      intentIds.length === 0
        ? []
        : (
            await this.pool.query<PaymentAttemptHistoryRecord>(
              SELECT_PAYMENT_ATTEMPTS,
              [intentIds],
            )
          ).rows;

    return {
      subscription: subscription.rows[0],
      billingIntents: intents.rows,
      paymentAttempts: attempts,
    };
  }
}
