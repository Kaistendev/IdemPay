import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_QUERIES } from './notifications.constants';
import type {
  OutboxEventFilters,
  OutboxEventResponse,
  OutboxQueriesPort,
} from './notifications.types';

@Injectable()
export class NotificationsQueryService {
  constructor(
    @Inject(OUTBOX_QUERIES) private readonly outbox: OutboxQueriesPort,
  ) {}

  async findEvents(
    filters: OutboxEventFilters,
  ): Promise<{ events: OutboxEventResponse[] }> {
    const records = await this.outbox.findEvents(filters);

    return {
      events: records.map((event) => ({
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        payload: event.payload,
        status: 'PENDING',
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }
}
