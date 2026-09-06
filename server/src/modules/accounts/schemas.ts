import { z } from "zod";
import { currency } from "../../shared/decimal.js";
export const accountInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    assetClass: z.enum(["crypto", "equities", "cash", "other"]),
    sourceType: z.enum(["manual", "hyperliquid", "dydx", "evm_wallet"]),
    institution: z.string().max(120).nullable().optional(),
    baseCurrency: currency.default("EUR"),
    externalAddress: z.string().max(100).nullable().optional(),
    externalSubaccount: z
      .number()
      .int()
      .min(0)
      .max(128000)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.sourceType === "manual" && a.externalAddress)
      ctx.addIssue({
        code: "custom",
        message: "Manual accounts do not accept external addresses",
      });
    if (a.sourceType !== "manual" && !a.externalAddress)
      ctx.addIssue({ code: "custom", message: "Public address required" });
    if (
      ["hyperliquid", "evm_wallet"].includes(a.sourceType) &&
      !/^0x[0-9a-fA-F]{40}$/.test(a.externalAddress ?? "")
    )
      ctx.addIssue({ code: "custom", message: "Invalid public EVM address" });
    if (
      a.sourceType === "dydx" &&
      !/^dydx1[0-9a-z]{38}$/.test(a.externalAddress ?? "")
    )
      ctx.addIssue({ code: "custom", message: "Invalid public dYdX address" });
  });
export type AccountInput = z.infer<typeof accountInput>;
export interface Account {
  id: string;
  name: string;
  assetClass: string;
  sourceType: string;
  institution: string | null;
  provider?: string | null;
  baseCurrency: string;
  externalAddress: string | null;
  externalSubaccount: number | null;
  metadata: Record<string, unknown>;
  isArchived: boolean;
  updatedAt: Date;
}
