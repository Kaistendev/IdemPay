import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsQueryRepository } from './notifications.query.repository';
import { NotificationsQueryService } from './notifications.query.service';
import { OUTBOX_QUERIES } from './notifications.constants';

@Module({
  imports: [HealthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsQueryService,
    NotificationsQueryRepository,
    { provide: OUTBOX_QUERIES, useExisting: NotificationsQueryRepository },
  ],
})
export class NotificationsModule {}
