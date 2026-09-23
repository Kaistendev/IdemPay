import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import type {
  BillingSchedulerRepositoryPort,
  SchedulableSubscription,
  SchedulerIntentExposure,
  SchedulerIntentSnapshot,
} from './billing-scheduler.types';

const LIST_ACTIVE = `
SELECT id, amount, currency, frequency,
       to_char(anchor_date, 'YYYY-MM-DD') AS "anchorDate",
       status
FROM subscriptions
WHERE status = 'ACTIVE'
`;

const INSERT_INTENT = `
INSERT INTO billing_intents
  (subscription_id, billing_cycle, schedule_date, amount, currency, status,
   next_attempt_at, origin_idempotency_key)
VALUES ($1, $2, $3::date, $4, $5, 'SCHEDULED', now(), NULL)
ON CONFLICT (subscription_id, billing_cycle) DO NOTHING
RETURNING id
`;

const LIST_EXISTING_INTENTS = `
SELECT billing_cycle, status
FROM billing_intents
WHERE subscription_id = $1
`;

const INSERT_OMITTED = `
INSERT INTO billing_intents
  (subscription_id, billing_cycle, schedule_date, amount, currency, status,
   next_attempt_at, omitted_reason, settled_at, origin_idempotency_key)
VALUES ($1, $2, $3::date, $4, $5, 'OMITTED', NULL, $6, now(), NULL)
ON CONFLICT (subscription_id, billing_cycle) DO NOTHING
RETURNING id
`;

interface SubscriptionRow {
  id: string;
  amount: string;
  currency: string;
  frequency: SchedulableSubscription['frequency'];
  anchorDate: string;
  status: 'ACTIVE';
}

@Injectable()
export class BillingSchedulerRepository implements BillingSchedulerRepositoryPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listActiveSubscriptions(): Promise<SchedulableSubscription[]> {
    const { rows } = await this.pool.query<SubscriptionRow>(LIST_ACTIVE);
    return rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      currency: row.currency,
      frequency: row.frequency,
      anchorDate: row.anchorDate,
      status: row.status,
    }));
  }

  async scheduleIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    const { rows } = await this.pool.query<{ id: string }>(INSERT_INTENT, [
      input.subscription.id,
      input.billingCycle,
      input.scheduleDate,
      input.subscription.amount,
      input.subscription.currency,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      scheduleDate: input.scheduleDate,
      amount: input.subscription.amount,
      currency: input.subscription.currency,
      status: 'SCHEDULED',
      omittedReason: null,
    };
  }

  async listExistingIntents(
    subscriptionId: string,
  ): Promise<SchedulerIntentExposure[]> {
    const { rows } = await this.pool.query<{
      billing_cycle: string;
      status: BillingIntentStatus;
    }>(LIST_EXISTING_INTENTS, [subscriptionId]);
    return rows.map((row) => ({
      billingCycle: row.billing_cycle,
      status: row.status,
    }));
  }

  async omitEngineDownIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    return this.omitIntent(input, 'ENGINE_DOWN');
  }

  async omitOverlapIntent(input: {
    subscription: SchedulableSubscription;
    billingCycle: string;
    scheduleDate: string;
  }): Promise<SchedulerIntentSnapshot | null> {
    return this.omitIntent(input, 'OVERLAP');
  }

  private async omitIntent(
    input: {
      subscription: SchedulableSubscription;
      billingCycle: string;
      scheduleDate: string;
    },
    reason: 'ENGINE_DOWN' | 'OVERLAP',
  ): Promise<SchedulerIntentSnapshot | null> {
    const { rows } = await this.pool.query<{ id: string }>(INSERT_OMITTED, [
      input.subscription.id,
      input.billingCycle,
      input.scheduleDate,
      input.subscription.amount,
      input.subscription.currency,
      reason,
    ]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      subscriptionId: input.subscription.id,
      billingCycle: input.billingCycle,
      scheduleDate: input.scheduleDate,
      amount: input.subscription.amount,
      currency: input.subscription.currency,
      status: 'OMITTED',
      omittedReason: reason,
    };
  }
}
