import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type {
  OutboxEventFilters,
  OutboxEventRecord,
  OutboxQueriesPort,
} from './notifications.types';

const SELECT_EVENTS = `
SELECT id,
       type,
       aggregate_id AS "aggregateId",
       payload,
       created_at AS "createdAt"
FROM notifications
WHERE ($1::text IS NULL OR type = $1)
  AND ($2::uuid IS NULL OR aggregate_id = $2)
ORDER BY created_at ASC, id ASC
`;

@Injectable()
export class NotificationsQueryRepository implements OutboxQueriesPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findEvents(filters: OutboxEventFilters): Promise<OutboxEventRecord[]> {
    const { rows } = await this.pool.query<OutboxEventRecord>(SELECT_EVENTS, [
      filters.type ?? null,
      filters.aggregateId ?? null,
    ]);
    return rows;
  }
}
