import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { CreateSubscriptionRequest } from './subscription.schema';
import type {
  SubscriptionRecord,
  SubscriptionsRepositoryPort,
} from './subscriptions.types';

const INSERT_SUBSCRIPTION = `
INSERT INTO subscriptions (amount, currency, frequency, anchor_date, timezone)
VALUES ($1, $2, $3, $4, $5)
RETURNING
  id,
  amount,
  currency,
  frequency,
  anchor_date::text AS "startDate",
  timezone,
  status,
  created_at AS "createdAt"
`;

@Injectable()
export class SubscriptionsRepository implements SubscriptionsRepositoryPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(input: CreateSubscriptionRequest): Promise<SubscriptionRecord> {
    const { rows } = await this.pool.query<SubscriptionRecord>(
      INSERT_SUBSCRIPTION,
      [
        input.amount,
        input.currency,
        input.frequency,
        input.startDate,
        input.timezone,
      ],
    );

    return rows[0];
  }
}
