import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { TransitionsService } from '../transitions/transitions.service';
import { SUBSCRIPTION_LIFECYCLE } from './subscriptions.constants';
import type {
  SubscriptionCancellationResult,
  SubscriptionLifecyclePort,
  SubscriptionPauseResult,
  SubscriptionResumeResult,
} from './subscriptions.types';

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    @Inject(SUBSCRIPTION_LIFECYCLE)
    private readonly repository: SubscriptionLifecyclePort,
    private readonly transitions: TransitionsService,
  ) {}

  async cancel(id: string): Promise<SubscriptionCancellationResult> {
    const snapshot = await this.repository.load(id);

    if (snapshot === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    if (snapshot.status === 'CANCELLED' && snapshot.cancelledAt) {
      return {
        id: snapshot.id,
        status: 'CANCELLED',
        cancelledAt: snapshot.cancelledAt,
        omittedIntents: 0,
      };
    }

    this.transitions.assertTransition(
      'subscription',
      snapshot.status,
      'CANCELLED',
    );

    const omitted = snapshot.liveIntents.filter(
      (intent) =>
        intent.status === 'SCHEDULED' || intent.status === 'RETRY_PENDING',
    );
    for (const intent of omitted) {
      this.transitions.assertTransition(
        'billingIntent',
        intent.status,
        'OMITTED',
      );
    }

    const result = await this.repository.applyCancellation(
      snapshot.id,
      omitted.map((intent) => intent.id),
    );

    if (result === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    return {
      id: snapshot.id,
      status: 'CANCELLED',
      cancelledAt: result.cancelledAt,
      omittedIntents: result.omittedCount,
    };
  }

  async pause(id: string): Promise<SubscriptionPauseResult> {
    const snapshot = await this.repository.load(id);

    if (snapshot === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    if (snapshot.status === 'CANCELLED') {
      throw new ConflictException({
        error: ErrorCode.InvalidTransition,
        message: 'A cancelled subscription cannot be paused',
      });
    }

    if (snapshot.status === 'PAUSED') {
      return {
        id: snapshot.id,
        status: 'PAUSED',
        omittedIntents: 0,
      };
    }

    this.transitions.assertTransition(
      'subscription',
      snapshot.status,
      'PAUSED',
    );

    const omitted = snapshot.liveIntents.filter(
      (intent) =>
        intent.status === 'SCHEDULED' || intent.status === 'RETRY_PENDING',
    );
    for (const intent of omitted) {
      this.transitions.assertTransition(
        'billingIntent',
        intent.status,
        'OMITTED',
      );
    }

    const result = await this.repository.applyPause(
      snapshot.id,
      omitted.map((intent) => intent.id),
    );

    if (result === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    return {
      id: snapshot.id,
      status: 'PAUSED',
      omittedIntents: result.omittedCount,
    };
  }

  async resume(id: string): Promise<SubscriptionResumeResult> {
    const snapshot = await this.repository.load(id);

    if (snapshot === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    if (snapshot.status !== 'PAUSED') {
      throw new ConflictException({
        error: ErrorCode.InvalidTransition,
        message: `A ${snapshot.status.toLowerCase()} subscription cannot be resumed`,
      });
    }

    this.transitions.assertTransition(
      'subscription',
      snapshot.status,
      'ACTIVE',
    );

    const result = await this.repository.applyResume(snapshot.id);

    if (result === null) {
      throw new NotFoundException({
        error: ErrorCode.NotFound,
        message: 'Subscription not found',
      });
    }

    return {
      id: snapshot.id,
      status: 'ACTIVE',
    };
  }
}
