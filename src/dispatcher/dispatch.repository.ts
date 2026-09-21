import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import type { ChargeDispatchRepositoryPort } from './dispatch.types';

const PICK_DUE = `
SELECT id
FROM billing_intents
WHERE status IN ('SCHEDULED', 'RETRY_PENDING')
  AND next_attempt_at IS NOT NULL
  AND next_attempt_at <= now()
ORDER BY next_attempt_at
LIMIT $1
FOR UPDATE SKIP LOCKED
`;

@Injectable()
export class DispatchRepository implements ChargeDispatchRepositoryPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async dispatchDue(batchSize: number): Promise<string[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(PICK_DUE, [
        batchSize,
      ]);
      await client.query('COMMIT');
      return rows.map((row) => row.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
