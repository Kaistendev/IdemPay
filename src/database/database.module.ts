import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { MigrationRunner } from './migration-runner';

@Module({
  imports: [HealthModule],
  providers: [MigrationRunner],
  exports: [MigrationRunner],
})
export class DatabaseModule {}
