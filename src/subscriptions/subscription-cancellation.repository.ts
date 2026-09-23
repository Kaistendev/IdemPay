import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  BillingIntentLiveRecord,
  SubscriptionLifecyclePort,
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

const APPLY_PAUSE = `
UPDATE subscriptions
SET status = 'PAUSED'
WHERE id = $1
RETURNING id
`;

const APPLY_RESUME = `
UPDATE subscriptions
SET status = 'ACTIVE'
WHERE id = $1
RETURNING id
`;

const OMIT_INTENTS = `
UPDATE billing_intents
SET status = 'OMITTED',
    omitted_reason = $2::text,
    settled_at = now()
WHERE id = ANY($1::uuid[])
  AND status IN ('SCHEDULED', 'RETRY_PENDING')
`;

const APPEND_CANCELLATION_EVENT = `
INSERT INTO notifications (type, aggregate_id, payload)
VALUES ('CancellationEvent', $1, $2)
`;

@Injectable()
export class SubscriptionCancellationRepository implements SubscriptionLifecyclePort {
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
          : await client.query(OMIT_INTENTS, [
              omittedIntentIds,
              'SUBSCRIPTION_CANCELLED',
            ]);

      await client.query(APPEND_CANCELLATION_EVENT, [
        id,
        { subscriptionId: id, reason: 'ADMIN' },
      ]);

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

  async applyPause(
    id: string,
    omittedIntentIds: readonly string[],
  ): Promise<{ omittedCount: number } | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const paused = await client.query<{ id: string }>(APPLY_PAUSE, [id]);

      if (paused.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const omitted =
        omittedIntentIds.length === 0
          ? { rowCount: 0 }
          : await client.query(OMIT_INTENTS, [
              omittedIntentIds,
              'SUBSCRIPTION_PAUSED',
            ]);

      await client.query('COMMIT');

      return { omittedCount: omitted.rowCount ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async applyResume(id: string): Promise<{ id: string } | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const resumed = await client.query<{ id: string }>(APPLY_RESUME, [id]);

      if (resumed.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('COMMIT');

      return { id: resumed.rows[0].id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
