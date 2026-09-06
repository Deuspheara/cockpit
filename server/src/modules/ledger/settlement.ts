import { Decimal, money, type DecimalString } from "../../shared/decimal.js";
import type { Transaction } from "./schemas.js";

/** Signed cash settlement; absence means the history cannot establish cash. */
export function tradeCashMovement(trade: Transaction): DecimalString | null {
  if (trade.netCashAmount != null) return money(trade.netCashAmount);
  const gross =
    trade.grossAmount ??
    (trade.unitPrice != null
      ? new Decimal(trade.quantity).mul(trade.unitPrice).toString()
      : null);
  if (gross === null) return null;
  return money(
    new Decimal(gross)
      .mul(trade.type === "BUY" ? -1 : 1)
      .minus(trade.feeAmount ?? 0)
      .minus(trade.taxAmount ?? 0),
  );
}
