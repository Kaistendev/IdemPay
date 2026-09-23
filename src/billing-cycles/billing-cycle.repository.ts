import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import type {
  BillingCycleRepositoryPort,
  BillingCycleSubscriptionSnapshot,
  BillingIntentSnapshot,
  GetOrCreateIntentResult,
} from './billing-cycle.types';

const FIND_SUBSCRIPTION = `
SELECT id, amount, currency, status
FROM subscriptions
WHERE id = $1
`;

const INSERT_INTENT = `
INSERT INTO billing_intents
  (subscription_id, billing_cycle, schedule_date, amount, currency, status,
   next_attempt_at, origin_idempotency_key)
VALUES ($1, $2, $3::date, $4, $5, 'SCHEDULED', now(), $6)
ON CONFLICT (subscription_id, billing_cycle) DO NOTHING
RETURNING id
`;

const FIND_INTENT = `
SELECT i.id, i.subscription_id AS "subscriptionId",
       i.billing_cycle AS "billingCycle",
       to_char(i.schedule_date, 'YYYY-MM-DD') AS "scheduleDate",
       i.amount, i.currency, i.status,
       i.omitted_reason AS "omittedReason", i.settled_at AS "settledAt"
FROM billing_intents i
WHERE i.subscription_id = $1 AND i.billing_cycle = $2
`;

interface SubscriptionRow {
  id: string;
  amount: string;
  currency: string;
  status: string;
}

interface IntentRow {
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
export class BillingCycleRepository implements BillingCycleRepositoryPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findSubscription(
    id: string,
  ): Promise<BillingCycleSubscriptionSnapshot | null> {
    const { rows } = await this.pool.query<SubscriptionRow>(FIND_SUBSCRIPTION, [
      id,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      status: this.subscriptionStatus(row.status),
    };
  }

  async getOrCreateIntent(input: {
    subscription: BillingCycleSubscriptionSnapshot;
    billingCycle: string;
    idempotencyKey: string;
  }): Promise<GetOrCreateIntentResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      let created = false;
      if (input.subscription.status === 'ACTIVE') {
        const inserted = await client.query<{ id: string }>(INSERT_INTENT, [
          input.subscription.id,
          input.billingCycle,
          input.billingCycle,
          input.subscription.amount,
          input.subscription.currency,
          input.idempotencyKey,
        ]);
        created = inserted.rows[0] !== undefined;
      }

      const intent = await this.queryIntent(
        client,
        input.subscription.id,
        input.billingCycle,
      );
      await client.query('COMMIT');

      if (intent) {
        return { intent, created };
      }
      return { reason: 'SUBSCRIPTION_NOT_ACTIVE' };
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
  ): Promise<BillingIntentSnapshot | null> {
    return this.queryIntent(this.pool, subscriptionId, billingCycle);
  }

  private async queryIntent(
    queryable: Pool | PoolClient,
    subscriptionId: string,
    billingCycle: string,
  ): Promise<BillingIntentSnapshot | null> {
    const { rows } = await queryable.query<IntentRow>(FIND_INTENT, [
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
      settledAt: row.settledAt,
    };
  }

  private subscriptionStatus(value: string) {
    if (value === 'ACTIVE' || value === 'PAUSED' || value === 'CANCELLED') {
      return value;
    }
    throw new Error(`Unexpected subscription status: ${value}`);
  }
}
