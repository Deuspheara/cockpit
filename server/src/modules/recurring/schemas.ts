import { z } from "zod";
import { currency, positiveDecimal } from "../../shared/decimal.js";
import { transactionType } from "../ledger/schemas.js";
export const ruleInput = z
  .object({
    accountId: z.uuid().toLowerCase(),
    assetId: z.uuid().toLowerCase(),
    transactionType,
    inputMode: z.enum(["quantity", "cash_amount"]),
    quantity: positiveDecimal.nullable().optional(),
    cashAmount: positiveDecimal.nullable().optional(),
    currency,
    cadence: z.enum(["weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(120).default(1),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    startOn: z.iso.date(),
    endOn: z.iso.date().nullable().optional(),
    autoPost: z.boolean().default(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      r.inputMode === "quantity"
        ? !r.quantity || !!r.cashAmount
        : !r.cashAmount || !!r.quantity
    )
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly the value matching inputMode",
      });
    if (r.autoPost && r.inputMode !== "quantity")
      ctx.addIssue({
        code: "custom",
        message: "Cash-amount rules cannot auto-post unknown quantities",
      });
    if (r.endOn && r.endOn < r.startOn)
      ctx.addIssue({ code: "custom", message: "End must not precede start" });
    if (r.transactionType === "ADJUSTMENT")
      ctx.addIssue({
        code: "custom",
        message: "Use explicit transfer direction",
      });
  });
export type RuleInput = z.infer<typeof ruleInput>;
export interface Rule extends RuleInput {
  id: string;
  seriesId: string;
  enabled: boolean;
  supersedesRuleId: string | null;
  updatedAt: Date;
}
