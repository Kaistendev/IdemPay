import { z } from 'zod';

export const chargeSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
});

export type ChargeRequest = z.infer<typeof chargeSchema>;
