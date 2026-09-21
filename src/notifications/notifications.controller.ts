import { Controller, Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/validation/zod-validation.pipe';
import { outboxEventsQuerySchema } from './notifications.query.schema';
import type { OutboxEventsQuery } from './notifications.query.schema';
import { NotificationsQueryService } from './notifications.query.service';
import type { OutboxEventResponse } from './notifications.types';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly outbox: NotificationsQueryService) {}

  @Get('events')
  findEvents(
    @Query(new ZodValidationPipe(outboxEventsQuerySchema))
    query: OutboxEventsQuery,
  ): Promise<{ events: OutboxEventResponse[] }> {
    return this.outbox.findEvents(query);
  }
}
