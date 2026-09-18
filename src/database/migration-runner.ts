import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../health/health.constants';
import { MIGRATIONS } from './migrations';

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

@Injectable()
export class MigrationRunner implements OnApplicationBootstrap {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(): Promise<string[]> {
    const client = await this.pool.connect();
    const applied: string[] = [];

    try {
      await client.query(CREATE_MIGRATIONS_TABLE);

      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM schema_migrations',
      );
      const done = new Set(rows.map((row) => row.id));

      for (const migration of MIGRATIONS) {
        if (done.has(migration.id)) {
          continue;
        }

        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
            migration.id,
          ]);
          await client.query('COMMIT');
          applied.push(migration.id);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }

      return applied;
    } finally {
      client.release();
    }
  }
}
