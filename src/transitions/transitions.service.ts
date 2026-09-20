import { Injectable } from '@nestjs/common';

import {
  ALLOWED_BILLING_INTENT_TRANSITIONS,
  ALLOWED_PAYMENT_ATTEMPT_TRANSITIONS,
  ALLOWED_SUBSCRIPTION_TRANSITIONS,
} from './transitions.constants';
import type {
  BillingIntentStatus,
  PaymentAttemptStatus,
  SubscriptionStatus,
  TransitionAggregate,
} from './transitions.types';

export interface IllegalTransition {
  aggregate: TransitionAggregate;
  from: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus;
  to: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus;
}

export class IllegalTransitionError extends Error {
  readonly aggregate: TransitionAggregate;
  readonly from: string;
  readonly to: string;

  constructor(transition: IllegalTransition) {
    super(
      `Transición ilegal [${transition.aggregate}] ` +
        `${transition.from} → ${transition.to}`,
    );
    this.name = 'IllegalTransitionError';
    this.aggregate = transition.aggregate;
    this.from = transition.from;
    this.to = transition.to;
  }
}

@Injectable()
export class TransitionsService {
  private readonly billingIntentAllowed = new Set<string>();
  private readonly paymentAttemptAllowed = new Set<string>();
  private readonly subscriptionAllowed = new Set<string>();

  constructor() {
    for (const [from, to] of ALLOWED_BILLING_INTENT_TRANSITIONS) {
      this.billingIntentAllowed.add(this.key(from, to));
    }
    for (const [from, to] of ALLOWED_PAYMENT_ATTEMPT_TRANSITIONS) {
      this.paymentAttemptAllowed.add(this.key(from, to));
    }
    for (const [from, to] of ALLOWED_SUBSCRIPTION_TRANSITIONS) {
      this.subscriptionAllowed.add(this.key(from, to));
    }
  }

  canTransition(
    aggregate: TransitionAggregate,
    from: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
    to: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
  ): boolean {
    const key = this.key(from, to);
    switch (aggregate) {
      case 'billingIntent':
        return this.billingIntentAllowed.has(key);
      case 'paymentAttempt':
        return this.paymentAttemptAllowed.has(key);
      case 'subscription':
        return this.subscriptionAllowed.has(key);
    }
  }

  assertTransition(
    aggregate: TransitionAggregate,
    from: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
    to: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
  ): void {
    if (!this.canTransition(aggregate, from, to)) {
      throw new IllegalTransitionError({ aggregate, from, to });
    }
  }

  private key(
    from: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
    to: BillingIntentStatus | PaymentAttemptStatus | SubscriptionStatus,
  ): string {
    return `${from}->${to}`;
  }
}
