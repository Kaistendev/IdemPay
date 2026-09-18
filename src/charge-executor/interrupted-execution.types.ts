export interface RecoveredExecution {
  attemptId: string;
  billingIntentId: string;
  providerOperationId: string;
}

export interface InterruptedExecutionRecoveryPort {
  recoverExpired(): Promise<RecoveredExecution[]>;
}
