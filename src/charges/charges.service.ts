import { Injectable } from '@nestjs/common';
import type { ChargeRequest } from './charge.schema';
import type { ChargeResult } from './charges.types';

@Injectable()
export class ChargesService {
  private executions = 0;

  create(request: ChargeRequest): ChargeResult {
    this.executions += 1;
    return {
      id: `chg_${this.executions}`,
      status: 'CREATED',
      amount: request.amount,
      currency: request.currency,
    };
  }

  executionCount(): number {
    return this.executions;
  }
}
