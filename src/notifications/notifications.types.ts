export const OUTBOX_EVENT_TYPES = ['CancellationEvent'] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEventRecord {
  id: string;
  type: OutboxEventType;
  aggregateId: string;
  payload: unknown;
  createdAt: Date;
}

export interface OutboxEventFilters {
  type?: OutboxEventType;
  aggregateId?: string;
}

export interface OutboxEventResponse {
  id: string;
  type: OutboxEventType;
  aggregateId: string;
  payload: unknown;
  status: 'PENDING';
  createdAt: string;
}

export interface OutboxQueriesPort {
  findEvents(filters: OutboxEventFilters): Promise<OutboxEventRecord[]>;
}
