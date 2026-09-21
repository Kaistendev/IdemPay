export interface ChargeDispatchRepositoryPort {
  dispatchDue(batchSize: number): Promise<string[]>;
}

export interface ChargeJobEnqueuer {
  add(
    name: string,
    data: { billingIntentId: string },
    options?: {
      jobId?: string;
      removeOnComplete?: boolean;
      removeOnFail?: boolean;
    },
  ): Promise<unknown>;
}
