import { z } from "zod";
import {
  Decimal,
  currency,
  positiveDecimal,
  nonnegativeDecimal,
} from "../../shared/decimal.js";
export const transactionType = z.enum([
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "FEE",
  "INCOME",
  "FUNDING",
  "ADJUSTMENT",
]);
export const transactionInput = z
  .object({
    accountId: z.uuid().toLowerCase(),
    assetId: z.uuid().toLowerCase(),
    type: transactionType,
    occurredAt: z.iso.datetime({ offset: true }),
    quantity: positiveDecimal,
    unitPrice: nonnegativeDecimal.nullable().optional(),
    currency,
    grossAmount: nonnegativeDecimal.nullable().optional(),
    feeAmount: nonnegativeDecimal.nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (
      t.grossAmount != null &&
      t.unitPrice != null &&
      !new Decimal(t.quantity)
        .mul(t.unitPrice)
        .minus(t.grossAmount)
        .abs()
        .lte("0.01")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Gross amount must agree with quantity × unit price within currency rounding",
      });
    if (t.type === "ADJUSTMENT")
      ctx.addIssue({
        code: "custom",
        message: "Use explicit transfer in/out for quantity corrections",
      });
  });
export type TransactionInput = z.infer<typeof transactionInput>;
export interface Transaction extends TransactionInput {
  id: string;
  source: string;
  isVoided: boolean;
  externalId: string | null;
  recurrenceOccurrenceId: string | null;
  updatedAt: Date;
}
export const observationInput = z
  .object({
    accountId: z.uuid().toLowerCase(),
    assetId: z.uuid().toLowerCase(),
    observedAt: z.iso.datetime({ offset: true }),
    quantity: nonnegativeDecimal,
    unitPrice: nonnegativeDecimal.nullable().optional(),
    marketValue: nonnegativeDecimal.nullable().optional(),
    currency,
    costBasis: nonnegativeDecimal.nullable().optional(),
  })
  .strict();
export type ObservationInput = z.infer<typeof observationInput>;
