export type ChargeStatus = 'CREATED';

export interface ChargeResult {
  id: string;
  status: ChargeStatus;
  amount: number;
  currency: string;
}
