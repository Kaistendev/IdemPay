export type IdempotencyState = 'PROCESSING' | 'SETTLED';

export interface IdempotencyResponse {
  statusCode: number;
  body: unknown;
}

export interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  state: IdempotencyState;
  response: IdempotencyResponse | null;
  billingIntentRef: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface BeginIdempotencyResult {
  acquired: boolean;
  record: IdempotencyRecord;
}

export interface IdempotencySettlement {
  response: IdempotencyResponse;
  billingIntentRef: string | null;
}

export interface IdempotencyStorePort {
  begin(key: string, payloadHash: string): Promise<BeginIdempotencyResult>;
  settle(
    key: string,
    settlement: IdempotencySettlement,
  ): Promise<IdempotencyRecord | null>;
  read(key: string): Promise<IdempotencyRecord | null>;
  ttlMillis(key: string): Promise<number>;
}
