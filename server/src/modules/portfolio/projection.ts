import { Decimal, money, type DecimalString } from "../../shared/decimal.js";
import type { Transaction } from "../ledger/schemas.js";
const decreases = new Set(["SELL", "WITHDRAWAL", "TRANSFER_OUT", "FEE"]);
export function ledgerQuantity(
  transactions: Pick<Transaction, "quantity" | "type" | "isVoided">[],
): DecimalString {
  let total = new Decimal(0);
  for (const t of transactions)
    if (!t.isVoided)
      total = decreases.has(t.type)
        ? total.minus(t.quantity)
        : total.plus(t.quantity);
  return money(total);
}
export function ledgerCost(
  transactions: Transaction[],
): DecimalString | undefined {
  let quantity = new Decimal(0),
    cost = new Decimal(0);
  for (const t of transactions
    .filter((t) => !t.isVoided)
    .sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime() ||
        a.id.localeCompare(b.id),
    )) {
    const q = new Decimal(t.quantity);
    if (t.type === "BUY" && t.unitPrice != null) {
      quantity = quantity.plus(q);
      cost = cost
        .plus(q.mul(t.unitPrice))
        .plus(t.feeAmount ?? 0)
        .plus(t.taxAmount ?? 0);
    } else if (t.type === "SELL" && quantity.gte(q) && quantity.gt(0)) {
      cost = cost.mul(quantity.minus(q)).div(quantity);
      quantity = quantity.minus(q);
    } else return undefined;
  }
  return money(cost);
}
export interface PositionView {
  network?: string;
  contractAddress?: string;
  priceQuotedAt?: string;
  priceIssue?: string;
  assetId: string;
  symbol: string;
  name: string;
  assetType: string;
  quantity?: DecimalString;
  price?: DecimalString;
  marketValue?: DecimalString;
  currency: string;
  costBasis?: DecimalString;
  unrealizedPnl?: DecimalString;
  realizedPnl?: DecimalString;
  side?: "long" | "short";
  entryPrice?: DecimalString;
  leverage?: DecimalString;
  liquidationPrice?: DecimalString;
  source: string;
  observedAt?: string;
  stale: boolean;
}
export function reconciliationDelta(
  expected: string,
  observed: string,
  assetType: string,
) {
  const delta = new Decimal(observed).minus(expected);
  const tolerance =
    assetType === "crypto" || assetType === "perp" ? "0.00000001" : "0.000001";
  return delta.abs().lte(tolerance) ? null : money(delta);
}
