import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  BillingIntentLiveRecord,
  SubscriptionCancellationPort,
  SubscriptionLifecycleSnapshot,
  SubscriptionStatus,
} from './subscriptions.types';

const LOAD_SUBSCRIPTION = `
SELECT id, status, cancelled_at AS "cancelledAt"
FROM subscriptions
WHERE id = $1
`;

const LOAD_LIVE_INTENTS = `
SELECT id, status
FROM billing_intents
WHERE subscription_id = $1
  AND status IN ('SCHEDULED', 'IN_FLIGHT', 'RETRY_PENDING', 'UNKNOWN')
ORDER BY created_at ASC
`;

const APPLY_CANCELLATION = `
UPDATE subscriptions
SET status = 'CANCELLED', cancelled_at = now()
WHERE id = $1
RETURNING cancelled_at AS "cancelledAt"
`;

const OMIT_INTENTS = `
UPDATE billing_intents
SET status = 'OMITTED',
    omitted_reason = 'SUBSCRIPTION_CANCELLED',
    settled_at = now()
WHERE id = ANY($1::uuid[])
  AND status IN ('SCHEDULED', 'RETRY_PENDING')
`;

@Injectable()
export class SubscriptionCancellationRepository implements SubscriptionCancellationPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async load(id: string): Promise<SubscriptionLifecycleSnapshot | null> {
    const subscription = await this.pool.query<{
      id: string;
      status: SubscriptionStatus;
      cancelledAt: Date | null;
    }>(LOAD_SUBSCRIPTION, [id]);

    if (subscription.rows.length === 0) {
      return null;
    }

    const row = subscription.rows[0];
    const intents = await this.pool.query<BillingIntentLiveRecord>(
      LOAD_LIVE_INTENTS,
      [id],
    );

    return {
      id: row.id,
      status: row.status,
      cancelledAt: row.cancelledAt,
      liveIntents: intents.rows,
    };
  }

  async applyCancellation(
    id: string,
    omittedIntentIds: readonly string[],
  ): Promise<{ cancelledAt: Date; omittedCount: number } | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const cancelled = await client.query<{ cancelledAt: Date }>(
        APPLY_CANCELLATION,
        [id],
      );

      if (cancelled.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const omitted =
        omittedIntentIds.length === 0
          ? { rowCount: 0 }
          : await client.query(OMIT_INTENTS, [omittedIntentIds]);

      await client.query('COMMIT');

      return {
        cancelledAt: cancelled.rows[0].cancelledAt,
        omittedCount: omitted.rowCount ?? 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
