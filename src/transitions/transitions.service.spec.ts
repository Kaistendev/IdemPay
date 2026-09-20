import { Test, TestingModule } from '@nestjs/testing';

import {
  ALLOWED_BILLING_INTENT_TRANSITIONS,
  ALLOWED_PAYMENT_ATTEMPT_TRANSITIONS,
  ALLOWED_SUBSCRIPTION_TRANSITIONS,
  BILLING_INTENT_STATES,
  PAYMENT_ATTEMPT_STATES,
  SUBSCRIPTION_STATES,
} from './transitions.constants';
import { TransitionsService } from './transitions.service';
import type {
  TransitionAggregate,
} from './transitions.types';

const BILLING_INTENT_STATES = [
  'SCHEDULED',
  'IN_FLIGHT',
  'RETRY_PENDING',
  'SUCCEEDED',
  'FAILED_FINAL',
  'UNKNOWN',
  'OMITTED',
] as const;

const PAYMENT_ATTEMPT_STATES = [
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
] as const;

const SUBSCRIPTION_STATES = [
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
] as const;

interface AggregateCase {
  aggregate: TransitionAggregate;
  states: readonly string[];
  allowed: ReadonlyArray<readonly [string, string]>;
}

const AGGREGATE_CASES: readonly AggregateCase[] = [
  {
    aggregate: 'billingIntent',
    states: BILLING_INTENT_STATES,
    allowed: ALLOWED_BILLING_INTENT_TRANSITIONS,
  },
  {
    aggregate: 'paymentAttempt',
    states: PAYMENT_ATTEMPT_STATES,
    allowed: ALLOWED_PAYMENT_ATTEMPT_TRANSITIONS,
  },
  {
    aggregate: 'subscription',
    states: SUBSCRIPTION_STATES,
    allowed: ALLOWED_SUBSCRIPTION_TRANSITIONS,
  },
];

describe('TransitionsService', () => {
  let service: TransitionsService;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [TransitionsService],
    }).compile();

    service = moduleRef.get(TransitionsService);
  });

  describe.each(AGGREGATE_CASES)(
    '$aggregate',
    ({ aggregate, states, allowed }) => {
      const allowedKeys = new Map(
        allowed.map(([from, to]) => [`${from}->${to}`, true]),
      );

      it.each(states.flatMap((from) =>
        states.map((to) => ({ from, to })),
      ))(
        decodeURIComponent(
          'permite $from -> $to solo si est%c3%a1 en la matriz (INV-07/08)',
        ),
        ({ from, to }) => {
          const expected = allowedKeys.has(`${from}->${to}`);
          expect(service.canTransition(aggregate, from, to)).toBe(expected);
        },
      );

      it('SUCCEEDED no admite salida (INV-07)', () => {
        for (const to of states) {
          expect(
            service.canTransition(aggregate, 'SUCCEEDED', to),
          ).toBe(false);
        }
      });

      it('ningún estado admite auto-transición', () => {
        for (const from of states) {
          expect(service.canTransition(aggregate, from, from)).toBe(false);
        }
      });
    },
  );

  it('assertTransition lanza IllegalTransitionError en transición ilegal', () => {
    expect(() =>
      service.assertTransition(
        'billingIntent',
        'SUCCEEDED',
        'IN_FLIGHT',
      ),
    ).toThrow(/Transición ilegal/);
  });

  it('assertTransition no lanza en transición permitida', () => {
    expect(() =>
      service.assertTransition('subscription', 'ACTIVE', 'PAUSED'),
    ).not.toThrow();
  });
});
