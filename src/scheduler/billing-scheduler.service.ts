import { Inject, Injectable } from '@nestjs/common';
import { CalendarService } from '../calendar/calendar.service';
import type { BillingIntentStatus } from '../subscriptions/subscriptions.types';
import { ENGINE_DOWN_TOLERANCE_MINUTES } from './billing-scheduler.config';
import { BILLING_SCHEDULER_REPOSITORY } from './billing-scheduler.constants';
import type { BillingSchedulerRepositoryPort } from './billing-scheduler.types';

const LIVE_INTENT_STATUSES: ReadonlySet<BillingIntentStatus> = new Set([
  'SCHEDULED',
  'IN_FLIGHT',
  'RETRY_PENDING',
  'UNKNOWN',
]);

function isLiveIntentStatus(status: BillingIntentStatus): boolean {
  return LIVE_INTENT_STATUSES.has(status);
}

@Injectable()
export class BillingSchedulerService {
  constructor(
    @Inject(BILLING_SCHEDULER_REPOSITORY)
    private readonly repository: BillingSchedulerRepositoryPort,
    private readonly calendar: CalendarService,
    @Inject(ENGINE_DOWN_TOLERANCE_MINUTES)
    private readonly toleranceMinutes: number,
  ) {}

  async sweep(): Promise<number> {
    const today = this.calendar.today();
    const subscriptions = await this.repository.listActiveSubscriptions();
    let created = 0;

    for (const subscription of subscriptions) {
      if (subscription.status !== 'ACTIVE') {
        continue;
      }

      const currentNominal = this.calendar.currentCycleDate(
        subscription.anchorDate,
        subscription.frequency,
        today,
      );
      if (currentNominal === null) {
        continue;
      }

      const existingIntents = await this.repository.listExistingIntents(
        subscription.id,
      );
      const statusByCycle = new Map(
        existingIntents.map((intent) => [intent.billingCycle, intent.status]),
      );
      let blockedByLive = false;

      for (let index = 0; ; index += 1) {
        const nominal = this.calendar.cycleDateAt(
          subscription.anchorDate,
          subscription.frequency,
          index,
        );
        if (nominal > today) {
          break;
        }

        const existingStatus = statusByCycle.get(nominal);
        if (existingStatus !== undefined) {
          if (isLiveIntentStatus(existingStatus)) {
            blockedByLive = true;
          }
          continue;
        }

        const scheduleDate = await this.calendar.nextBusinessDay(nominal);
        if (scheduleDate > today) {
          break;
        }

        if (blockedByLive) {
          if (
            this.calendar.isOverdueByTolerance(
              scheduleDate,
              today,
              this.toleranceMinutes,
            )
          ) {
            await this.repository.omitOverlapIntent({
              subscription,
              billingCycle: nominal,
              scheduleDate,
            });
          }
          continue;
        }

        const isCurrent = nominal === currentNominal;
        if (scheduleDate === today && isCurrent) {
          const intent = await this.repository.scheduleIntent({
            subscription,
            billingCycle: nominal,
            scheduleDate,
          });
          if (intent) {
            created += 1;
          }
          blockedByLive = true;
          continue;
        }

        if (
          this.calendar.isOverdueByTolerance(
            scheduleDate,
            today,
            this.toleranceMinutes,
          )
        ) {
          await this.repository.omitEngineDownIntent({
            subscription,
            billingCycle: nominal,
            scheduleDate,
          });
        }
      }
    }

    return created;
  }
}
