import { Decimal } from "decimal.js";
import { z } from "zod";
Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
export { Decimal };
export type DecimalString = string & { readonly __decimal: unique symbol };
export const decimalString = z
  .string()
  .regex(
    /^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/,
    "Expected decimal string with at most 20 integer and 18 fractional digits",
  );
export const positiveDecimal = decimalString.refine(
  (v) => new Decimal(v).gt(0),
  "Must be positive",
);
export const nonnegativeDecimal = decimalString.refine(
  (v) => new Decimal(v).gte(0),
  "Must be nonnegative",
);
export const money = (value: Decimal.Value): DecimalString =>
  new Decimal(value).toFixed(18) as DecimalString;
export const currency = z.string().regex(/^[A-Z]{3}$/);
