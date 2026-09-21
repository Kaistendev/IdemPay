import { z } from 'zod';
import { OUTBOX_EVENT_TYPES } from './notifications.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const outboxEventsQuerySchema = z.object({
  type: z.enum(OUTBOX_EVENT_TYPES).optional(),
  aggregateId: z
    .string()
    .regex(UUID_PATTERN, { message: 'aggregateId must be a valid UUID' })
    .optional(),
});

export type OutboxEventsQuery = z.infer<typeof outboxEventsQuerySchema>;
