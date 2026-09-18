import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  SubscriptionCancellationPort,
  SubscriptionCancellationResult,
  SubscriptionStatus,
} from './subscriptions.types';

const LOCK_SUBSCRIPTION = `
SELECT status, cancelled_at AS "cancelledAt"
FROM subscriptions
WHERE id = $1
FOR UPDATE
`;

const CANCEL_SUBSCRIPTION = `
UPDATE subscriptions
SET status = 'CANCELLED', cancelled_at = now()
WHERE id = $1
RETURNING cancelled_at AS "cancelledAt"
`;

const OMIT_PENDING_INTENTS = `
UPDATE billing_intents
SET status = 'OMITTED', settled_at = now()
WHERE subscription_id = $1 AND status = 'SCHEDULED'
`;

@Injectable()
export class SubscriptionCancellationRepository implements SubscriptionCancellationPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async cancel(id: string): Promise<SubscriptionCancellationResult | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const current = await client.query<{
        status: SubscriptionStatus;
        cancelledAt: Date | null;
      }>(LOCK_SUBSCRIPTION, [id]);

      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }

      const subscription = current.rows[0];

      if (subscription.status === 'CANCELLED' && subscription.cancelledAt) {
        await client.query('COMMIT');
        return {
          id,
          status: 'CANCELLED',
          cancelledAt: subscription.cancelledAt,
          omittedIntents: 0,
        };
      }

      const cancelled = await client.query<{ cancelledAt: Date }>(
        CANCEL_SUBSCRIPTION,
        [id],
      );
      const omitted = await client.query(OMIT_PENDING_INTENTS, [id]);

      await client.query('COMMIT');

      return {
        id,
        status: 'CANCELLED',
        cancelledAt: cancelled.rows[0].cancelledAt,
        omittedIntents: omitted.rowCount ?? 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
