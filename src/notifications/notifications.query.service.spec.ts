import { NotificationsQueryService } from './notifications.query.service';
import type {
  OutboxEventFilters,
  OutboxEventRecord,
  OutboxQueriesPort,
} from './notifications.types';

const CREATED_AT = new Date('2026-01-01T00:00:00Z');

const eventOf = (overrides: Partial<OutboxEventRecord>): OutboxEventRecord => ({
  id: '11111111-1111-1111-1111-111111111111',
  type: 'CancellationEvent',
  aggregateId: '22222222-2222-2222-2222-222222222222',
  payload: { subscriptionId: '22222222-2222-2222-2222-222222222222' },
  createdAt: CREATED_AT,
  ...overrides,
});

class FakeOutbox implements OutboxQueriesPort {
  readonly calls: OutboxEventFilters[] = [];

  constructor(private readonly records: OutboxEventRecord[] = []) {}

  findEvents(filters: OutboxEventFilters): Promise<OutboxEventRecord[]> {
    this.calls.push(filters);
    return Promise.resolve(this.records);
  }
}

describe('NotificationsQueryService', () => {
  it('forwards the filters to the outbox and maps events with PENDING status', async () => {
    const outbox = new FakeOutbox([eventOf({})]);
    const service = new NotificationsQueryService(outbox);

    const result = await service.findEvents({
      type: 'CancellationEvent',
      aggregateId: '22222222-2222-2222-2222-222222222222',
    });

    expect(outbox.calls).toEqual([
      {
        type: 'CancellationEvent',
        aggregateId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
    expect(result).toEqual({
      events: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          type: 'CancellationEvent',
          aggregateId: '22222222-2222-2222-2222-222222222222',
          payload: {
            subscriptionId: '22222222-2222-2222-2222-222222222222',
          },
          status: 'PENDING',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('returns an empty event list when the outbox has no matches', async () => {
    const service = new NotificationsQueryService(new FakeOutbox([]));

    await expect(service.findEvents({})).resolves.toEqual({ events: [] });
  });
});
